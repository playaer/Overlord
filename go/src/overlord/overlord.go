// Copyright 2015 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

package overlord

import (
	"code.google.com/p/go-uuid/uuid"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/googollee/go-socket.io"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	WEBSERVER_ADDR = "localhost:9000"
	LD_INTERVAL    = 5
)

type SpawnTerminalCmd struct {
	Sid string
}

type SpawnLogcatCmd struct {
	Sid      string
	Filename string
}

type ConnectLogcatCmd struct {
	Conn *websocket.Conn
}

type TerminateCmd struct {
}

type ShellCmd struct {
	Command string
	Output  chan []byte
}

// WebSocketContext is used for maintaining the session information of
// WebSocket requests. When requests come from Web Server, we create a new
// WebSocketConext to store the session ID and WebSocket connection. ConnServer
// will request a new terminal connection with client ID equals the session ID.
// This way, the ConnServer can retreive the connresponding WebSocketContext
// with it's client (session) ID and get the WebSocket.
type WebSocketContext struct {
	Sid  string
	Conn *websocket.Conn
}

func NewWebsocketContext(conn *websocket.Conn) *WebSocketContext {
	return &WebSocketContext{
		Sid:  uuid.New(),
		Conn: conn,
	}
}

type Overlord struct {
	agents   map[string]*ConnServer            // Normal ghost agents
	slogcats map[string]map[string]*ConnServer // Simple logcat clients
	wsctxs   map[string]*WebSocketContext      // (cid, WebSocketContext) mapping
	ioserver *socketio.Server
}

func NewOverlord() *Overlord {
	return &Overlord{
		agents:   make(map[string]*ConnServer),
		slogcats: make(map[string]map[string]*ConnServer),
		wsctxs:   make(map[string]*WebSocketContext),
	}
}

// Register a client.
func (self *Overlord) Register(conn *ConnServer) (*websocket.Conn, error) {
	msg, err := json.Marshal(map[string]interface{}{
		"mid": conn.mid,
		"cid": conn.cid,
	})
	if err != nil {
		return nil, err
	}

	var wsconn *websocket.Conn

	switch conn.mode {
	case AGENT:
		if _, ok := self.agents[conn.mid]; ok {
			return nil, errors.New("Register: duplicate machine ID: " + conn.mid)
		}

		self.agents[conn.mid] = conn
		self.ioserver.BroadcastTo("monitor", "agent joined", string(msg))
	case TERMINAL, LOGCAT:
		if ctx, ok := self.wsctxs[conn.cid]; !ok {
			return nil, errors.New("Register: client " + conn.cid +
				" registered without context")
		} else {
			wsconn = ctx.Conn
		}
	case SLOGCAT:
		if _, ok := self.slogcats[conn.mid]; !ok {
			self.slogcats[conn.mid] = make(map[string]*ConnServer)
		}
		if _, ok := self.slogcats[conn.mid][conn.cid]; ok {
			return nil, errors.New("Register: duplicate client ID: " + conn.cid)
		}
		self.slogcats[conn.mid][conn.cid] = conn
		self.ioserver.BroadcastTo("monitor", "slogcat joined", string(msg))
	default:
		return nil, errors.New("Register: Unknown client mode")
	}

	var id string
	if conn.mode == AGENT {
		id = conn.mid
	} else {
		id = conn.cid
	}

	log.Printf("%s %s registered\n", ModeStr(conn.mode), id)

	return wsconn, nil
}

// Unregister a client.
func (self *Overlord) Unregister(conn *ConnServer) {
	msg, err := json.Marshal(map[string]interface{}{
		"mid": conn.mid,
		"cid": conn.cid,
	})

	if err != nil {
		panic(err)
	}

	switch conn.mode {
	case AGENT:
		self.ioserver.BroadcastTo("monitor", "agent left", string(msg))
		delete(self.agents, conn.mid)
	case SLOGCAT:
		if _, ok := self.slogcats[conn.mid]; ok {
			self.ioserver.BroadcastTo("monitor", "slogcat left", string(msg))
			delete(self.slogcats[conn.mid], conn.cid)
			if len(self.slogcats[conn.mid]) == 0 {
				delete(self.slogcats, conn.mid)
			}
		}
	default:
		if _, ok := self.wsctxs[conn.cid]; ok {
			delete(self.wsctxs, conn.cid)
		}
	}

	var id string
	if conn.mode == AGENT {
		id = conn.mid
	} else {
		id = conn.cid
	}
	log.Printf("%s %s unregistered\n", ModeStr(conn.mode), id)
}

func (self *Overlord) AddWebsocketContext(wc *WebSocketContext) {
	self.wsctxs[wc.Sid] = wc
}

// Handle TCP Connection.
func (self *Overlord) handleConnection(conn net.Conn) {
	handler := NewConnServer(self, conn)
	go handler.Listen()
}

// Socket server main routine.
func (self *Overlord) ServSocket(port int) {
	addr := fmt.Sprintf("0.0.0.0:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		panic(err)
	}
	log.Printf("Overlord started, listening at %s", addr)
	for {
		conn, err := ln.Accept()
		if err != nil {
			panic(err)
		}
		log.Printf("Incomming connection from %s\n", conn.RemoteAddr())
		self.handleConnection(conn)
	}
}

// Initialize the Socket.io server.
func (self *Overlord) InitSocketIOServer() {
	server, err := socketio.NewServer(nil)
	if err != nil {
		log.Fatal(err)
	}

	server.On("connection", func(so socketio.Socket) {
		so.Join("monitor")
	})

	server.On("error", func(so socketio.Socket, err error) {
		log.Println("error:", err)
	})

	self.ioserver = server
}

// Web server main routine.
func (self *Overlord) ServHTTP(addr, app string) {
	var upgrader = websocket.Upgrader{
		ReadBufferSize:  BUFSIZ,
		WriteBufferSize: BUFSIZ,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	// Helper function for writing error message to WebSocket
	WebSocketSendError := func(ws *websocket.Conn, err string) {
		log.Println(err)
		msg := websocket.FormatCloseMessage(websocket.CloseProtocolError, err)
		ws.WriteMessage(websocket.CloseMessage, msg)
		ws.Close()
	}

	// PTY stream request handler.
	// We first create a WebSocketContext to store the connection, then send a
	// command to Overlord to client to spawn a terminal connection.
	PtyHandler := func(w http.ResponseWriter, r *http.Request) {
		log.Printf("Terminal request from %s\n", r.RemoteAddr)

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			panic(err)
		}

		vars := mux.Vars(r)
		mid := vars["mid"]
		if agent, ok := self.agents[mid]; ok {
			wc := NewWebsocketContext(conn)
			self.AddWebsocketContext(wc)
			agent.bridge <- SpawnTerminalCmd{wc.Sid}
		} else {
			WebSocketSendError(conn, "No client with mid "+mid)
		}
	}

	// Log stream request handler.
	// There are two different kinds of logcat connections: the normal logcat
	// and the simple-logcat. For the normal logcat request, we first create a
	// WebSocketContext to store the connection, then send a command to
	// ConnServer to client to spawn a logcat connection.
	LogcatHandler := func(w http.ResponseWriter, r *http.Request) {
		log.Printf("Logcat request from %s\n", r.RemoteAddr)

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			panic(err)
		}

		vars := mux.Vars(r)
		mid := vars["mid"]
		// The is a normal logcat request
		if agent, ok := self.agents[mid]; ok {
			if filename, ok := r.URL.Query()["filename"]; ok {
				wc := NewWebsocketContext(conn)
				self.AddWebsocketContext(wc)
				agent.bridge <- SpawnLogcatCmd{wc.Sid, filename[0]}
			} else {
				WebSocketSendError(conn, "No filename specified for logcat request "+mid)
			}
		} else {
			WebSocketSendError(conn, "No client with mid "+mid)
		}
	}

	// Simple-logcat request handler
	// We directly send the WebSocket connection to ConnServer for forwarding
	// the log stream.
	SimpleLogcatHandler := func(w http.ResponseWriter, r *http.Request) {
		log.Printf("Logcat request from %s\n", r.RemoteAddr)

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			panic(err)
		}

		vars := mux.Vars(r)
		mid := vars["mid"]
		cid := vars["cid"]
		// Check if it wants to connect to a simple logcat session
		if logcats, ok := self.slogcats[mid]; ok {
			if logcat, ok := logcats[cid]; ok {
				logcat.bridge <- ConnectLogcatCmd{conn}
			} else {
				WebSocketSendError(conn, "No client with cid "+cid)
			}
		} else {
			WebSocketSendError(conn, "No client with mid "+mid)
		}
	}

	// Shell command request handler.
	// We create a channel and send it to ConnServer, then wait on the channel
	// for result. ConnServer command the remote client to execute the command,
	// then send the result using the channel passed from Overlord.
	ShellHandler := func(w http.ResponseWriter, r *http.Request) {
		log.Printf("Shell request from %s\n", r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")

		vars := mux.Vars(r)
		mid := vars["mid"]
		command := r.FormValue("command")

		output := make(chan []byte)
		if agent, ok := self.agents[mid]; ok {
			agent.bridge <- ShellCmd{command, output}
		} else {
			w.Write([]byte(fmt.Sprintf(`{"error": "No client with mid %s", "output": ""}`, mid)))
			return
		}

		result_json := <-output
		w.Write(result_json)
	}

	// List all agents connected to the Overlord.
	AgentsListHandler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		data := make([]map[string]string, len(self.agents))
		idx := 0
		for _, agent := range self.agents {
			data[idx] = map[string]string{
				"mid": agent.mid,
				"cid": agent.cid,
			}
			idx++
		}

		result, err := json.Marshal(data)
		if err != nil {
			w.Write([]byte(fmt.Sprintf(`{"error", "%s"}`, err.Error())))
		} else {
			w.Write(result)
		}
	}

	// List all simple-logcat clients connected to the Overlord.
	SimpleLogcatsListHandler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		data := make([]map[string]interface{}, len(self.slogcats))
		idx := 0
		for mid, slogcats := range self.slogcats {
			var cids []string
			for cid, _ := range slogcats {
				cids = append(cids, cid)
			}
			data[idx] = map[string]interface{}{
				"mid":  mid,
				"cids": cids,
			}
			idx++
		}

		result, err := json.Marshal(data)
		if err != nil {
			w.Write([]byte(fmt.Sprintf(`{"error", "%s"}`, err.Error())))
		} else {
			w.Write(result)
		}
	}

	app_dir := filepath.Join(filepath.Dir(os.Args[0]), "app", app)
	if _, err := os.Stat(app_dir); os.IsNotExist(err) {
		log.Fatalf("App `%s' does not exist\n", app)
	}

	self.InitSocketIOServer()

	// Register the request handlers and start the WebServer.
	r := mux.NewRouter()
	r.HandleFunc("/api/pty/{mid}", PtyHandler)
	r.HandleFunc("/api/log/{mid}", LogcatHandler)
	r.HandleFunc("/api/slog/{mid}/{cid}", SimpleLogcatHandler)
	r.HandleFunc("/api/shell/{mid}", ShellHandler)
	r.HandleFunc("/api/agents/list", AgentsListHandler)
	r.HandleFunc("/api/slogcats/list", SimpleLogcatsListHandler)

	http.Handle("/api/", r)
	http.Handle("/api/socket.io/", self.ioserver)
	http.Handle("/", http.FileServer(http.Dir(app_dir)))

	err := http.ListenAndServe(WEBSERVER_ADDR, nil)
	if err != nil {
		log.Fatalf("net.http could not listen on address '%s': %s\n",
			WEBSERVER_ADDR, err)
	}
}

// Broadcast LAN discovery message.
func (self *Overlord) StartUDPBroadcast(port int) {
	conn, err := net.Dial("udp", fmt.Sprintf("%s:%d", net.IPv4bcast, port))
	if err != nil {
		panic(err)
	}

	ticker := time.NewTicker(time.Duration(LD_INTERVAL * time.Second))

	for {
		select {
		case <-ticker.C:
			conn.Write([]byte(fmt.Sprintf("OVERLORD :%d", OVERLORD_PORT)))
		}
	}
}

func overlord_usage() {
	fmt.Fprintf(os.Stderr, "Usage: overlord [OPTIONS]\n")
	flag.PrintDefaults()
	os.Exit(2)
}

func (self *Overlord) Serv() {
	var app = flag.String("app", "dashboard", "name of app to launch.")

	flag.Usage = overlord_usage
	flag.Parse()

	go self.ServSocket(OVERLORD_PORT)
	go self.ServHTTP(WEBSERVER_ADDR, *app)
	go self.StartUDPBroadcast(OVERLORD_LD_PORT)

	ticker := time.NewTicker(time.Duration(60 * time.Second))

	for {
		select {
		case <-ticker.C:
			log.Printf("#Goroutines, #Ghostclient: %d, %d\n",
				runtime.NumGoroutine(), len(self.agents))
		}
	}
}

func StartOverlord() {
	ovl := NewOverlord()
	ovl.Serv()
}