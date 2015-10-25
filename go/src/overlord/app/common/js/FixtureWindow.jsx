// Copyright 2015 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// View for Fixture Window
//
// - FixtureWindow
//   - Lights
//   - Terminals
//   - Controls
//   - MainLog
//   - AuxLogs
//     - AuxLog

LOG_BUF_SIZE = 8192

var FIXTURE_WINDOW_WIDTH = 420;
var FIXTURE_WINDOW_MARGIN = 10;

var LIGHT_CSS_MAP = {
  'light-toggle-off': 'label-danger',
  'light-toggle-on': 'label-success'
};

// FixtureWindow defines the layout and behavior of a fixture window,
// which has lights, terminals, controls and logs.
//
// Usage:
//   <FixtureWindow client={client} app={app}
//       [other attributes...] />
// where
//  @app: FixtureWindow will invoke app.addTerminal(id, term) to open an
//        terminal, where @id is a string used to distinguish different
//        terminals, @term is a terminal description object.
//  @client: an agent object, should have "properties" attribute,
//           which is an object defined by file "properties.json".
// A terminal description object would looks like the following in json:
// {
//   "name":"NUC",
//   "mid":"ghost 1"
//   // @path attribute is optional, without @path, it means that we are
//   // connecting to the fixture itself.
//   "path": "some path"
// }
// Given @id as identifier, and @term as a terminal description object, to open
// a terminal connection, you can use TerminalWindow:
//   <TerminalWindow key={id} mid={term.mid} id={id} title={id}
//       path={"/api/agent/tty/" + term.mid + extra}
//       uploadPath={"/api/agent/upload/" + term.mid}
//       app={this.props.app} progressBars={this.refs.uploadProgress}
//       onControl={onControl} onClose={onClose} />
//   where @extra = "?tty_device=" + term.path if term.path is defined.
//
// A client object would looks like the following in json:
// {
//   "mid": "machine ID",
//   "sid": "serial ID",
//   // see properties.sample.json
//   "properties": {
//     "ip": "127.0.0.1",
//     "ui": {
//       // Lights are used to show current status of the fixture, lights has
//       // two states: on and off, which is represent by setting "light"
//       // attribute to 'light-toggle-on' or 'light-toggle-off' (see below)
//       "lights": {
//         // A list of lights
//         "items": [
//           {
//             // Identifier of this light, if the output of @command contains
//             // LIGHT[@id]='light-toggle-on', then @light will be set to on.
//             "id": "ccd",
//             // Text to be shown
//             "label": "CCD",
//             // Set default state to off
//             "light": "light-toggle-off",
//             // Command to execute when clicked
//             "command": "case_close_debug",
//             // Will be called when the FixtureWindow is opened.
//             "init_cmd": "case_close_debug status"
//           },
//           {
//             "id": "dut-lid",
//             "label": "DUT LID"
//             "light": "light-toggle-off",
//             // @cmd will be execute every @interval milliseconds, you can
//             // output LIGHT[@id]='light-toggle-on' to change the light.
//             "poll": {
//               "cmd": "check_dut_exists -t lid",
//               "interval": 20000
//             },
//           }, ...
//         ],
//         // A master command which updates light status.
//         // "update_light_status" is a script we wrote that will respect
//         // @init_cmd and @poll attributes in items, you can implement your
//         // own script instead.
//         "update_command": "update_light_status"
//       },
//       // A list of terminals connected to this fixture, for example, there
//       // might be a terminal for fixture itself and a terminal for DUT.
//       "terminals": [
//         // Without @path_cmd attribute, will connect to fixture itself.
//         {
//           "name": "NUC"
//         },
//         // @path_cmd will be used to get the path of device.
//         {
//           "name": "AP"
//           "path_cmd": "ls /dev/google/Ryu_debug-*/serial/AP 2>/dev/null",
//         },
//       ],
//       // A list of buttons to control some functionality of the fixture.
//       "controls": [
//         // A command
//         {
//           "name": "Upgrade Firmware"
//           "command": "whale firmware upgrade",
//         },
//         // A command that will be toggled between two state.
//         {
//           "name": "Voltage Measurement",
//           "type": "toggle",
//           "on_command": "command to start measuring voltage",
//           "off_command": "command to stop measuring"
//         },
//         // A group of commands
//         {
//           "name": "Fixture control"
//           "group": [
//             {
//               "name": "whale close"
//               "command": "whale close",
//             },
//             {
//               "name": "whale open"
//               "command": "whale open",
//             },
//             {
//               "name": "io insertion"
//               "command": "whale insert",
//             },
//             {
//               "name": "charging"
//               "command": "whale charge",
//             }
//           ],
//         }
//       ],
//       // Path to the log files, FixtureWindow will keep polling the latest
//       // content of these file.
//       "logs": [
//         "/var/log/factory.log", ...
//       ]
//     },
//     // What catagories this fixture belongs to. If it contains "ui", an "UI"
//     // button will be shown on the /dashboard page. If it contains "whale",
//     // it will be shown on the /whale page.
//     "context": [
//       "ui", "whale", ...
//     ]
//   },
// }
var FixtureWindow = React.createClass({
  executeRemoteCmd: function (mid, cmd) {
    if (!this.isMounted()) {
      sock.close();
      return;
    }
    var url = "ws" + ((window.location.protocol == "https:")? "s": "" ) +
              "://" + window.location.host + "/api/agent/shell/" + mid +
              "?command=" + encodeURIComponent(cmd);
    var sock = new WebSocket(url);

    sock.onopen = function () {
      sock.onmessage = function (msg) {
        if (msg.data instanceof Blob) {
          ReadBlobAsText(msg.data, function(text) {
            this.refs.mainlog.appendLog(text);
          }.bind(this));
        }
      }.bind(this)
    }.bind(this)
    this.socks.push(sock);
  },
  componentWillUnmount: function() {
    for (var i = 0; i < this.socks.length; ++i) {
      this.socks[i].close();
    }
  },
  getInitialState: function () {
    this.socks = [];
    return {};
  },
  render: function () {
    var client = this.props.client;
    var style = {
      width: FIXTURE_WINDOW_WIDTH + 'px',
      margin: FIXTURE_WINDOW_MARGIN + 'px',
    };
    return (
      <div className="fixture-block panel panel-success" style={style}>
        <div className="panel-heading text-center">{abbr(client.mid, 60)}</div>
        <div className="panel-body">
          <Lights ref="lights" client={client} fixture={this} />
          <Terminals client={client} app={this.props.app} />
          <Controls ref="controls" client={client} fixture={this} />
          <MainLog ref="mainlog" fixture={this} id={client.mid} />
          <AuxLogs client={client} fixture={this} />
        </div>
      </div>
    );
  }
});


var Lights = React.createClass({
  updateLightStatus: function (id, status_class) {
    var node = $(this.refs[id].getDOMNode());
    node.removeClass(this.refs[id].props.prevLight);
    node.addClass(status_class);
    this.refs[id].props.prevLight = status_class;
  },
  scanForLightMsg: function (msg) {
    var patt = /LIGHT\[(.*)\]\s*=\s*'(\S*)'/g;
    var found;
    while (found = patt.exec(msg)) {
      this.updateLightStatus(found[1], LIGHT_CSS_MAP[found[2]]);
    }
  },
  componentDidMount: function() {
    var client = this.props.client;
    var update_command;

    if (typeof(client.properties.ui) != "undefined") {
      update_command = client.properties.ui.lights.update_command;
    }
    setTimeout(function() {
      this.props.fixture.executeRemoteCmd(client.mid, update_command);
    }.bind(this), 5000);
  },
  render: function () {
    var client = this.props.client;
    var lights = [];

    if (typeof(client.properties.ui) != "undefined") {
      lights = client.properties.ui.lights.items || [];
    }
    return (
      <div className="status-block well well-sm">
      {
        lights.map(function (light) {
          var extra_css = "";
          var extra = {};
          if (typeof(light.command) != "undefined") {
            extra_css = "status-light-clickable";
            extra.onClick = function() {
              this.props.fixture.executeRemoteCmd(client.mid, light.command);
            }.bind(this);
          }
          var light_css = LIGHT_CSS_MAP[light.light];
          return (
            <span key={light.id} className={"label " + extra_css + " " +
              light_css} prevLight={light_css} ref={light.id} {...extra}>
              {light.label}
            </span>
          );
        }.bind(this))
      }
      </div>
    );
  }
});

var Terminals = React.createClass({
  getCmdOutput: function (mid, cmd) {
    var url = "ws" + ((window.location.protocol == "https:")? "s": "" ) +
              "://" + window.location.host + "/api/agent/shell/" + mid +
              "?command=" + cmd;
    var sock = new WebSocket(url);
    var deferred = $.Deferred();

    sock.onopen = function (e) {
      var blobs = [];
      sock.onmessage = function (msg) {
        if (msg.data instanceof Blob) {
          blobs.push(msg.data);
        }
      }
      sock.onclose = function (e) {
        var value = "";
        if (blobs.length == 0) {
          deferred.resolve("");
        }
        for (var i = 0; i < blobs.length; i++) {
          ReadBlobAsText(blobs[i], function(current) {
            return function(text) {
              value += text;
              if (current == blobs.length - 1) {
                deferred.resolve(value);
              }
            }
          }(i));
        }
      }
    }
    return deferred.promise();
  },
  onTerminalClick: function (e) {
    var target = $(e.target);
    var mid = target.data("mid");
    var term = target.data("term");
    var id = mid + "::" + term.name;

    // Add mid reference to term object
    term.mid = mid;

    if (typeof(term.path_cmd) != "undefined" &&
        term.path_cmd.match(/^\s+$/) == null) {
      this.getCmdOutput(mid, term.path_cmd).done(function(path) {
        if (path.replace(/^\s+|\s+$/g, "") == "") {
          alert("This TTY device does not exist!");
        } else {
          term.path = path;
          this.props.app.addTerminal(id, term);
        }
      }.bind(this));
      return;
    }

    this.props.app.addTerminal(id, term);
  },
  render: function () {
    var client = this.props.client;
    var terminals = [];

    if (typeof(client.properties.ui) != "undefined") {
      terminals = client.properties.ui.terminals || [];
    }
    return (
      <div className="status-block well well-sm">
      {
        terminals.map(function (term) {
          return (
            <button className="btn btn-xs btn-info" data-mid={client.mid}
                data-term={JSON.stringify(term)} onClick={this.onTerminalClick}>
            {term.name}
            </button>
          );
        }.bind(this))
      }
      </div>
    );
  }
});

var Controls = React.createClass({
  onCommandClicked: function (e) {
    var target = $(e.target);
    var ctrl = target.data("ctrl");
    if (ctrl.type == "toggle") {
      if (target.hasClass("active")) {
        this.props.fixture.executeRemoteCmd(target.data("mid"), ctrl.off_command);
        target.removeClass("active");
      } else {
        this.props.fixture.executeRemoteCmd(target.data("mid"), ctrl.on_command);
        target.addClass("active");
      }
    } else {
      this.props.fixture.executeRemoteCmd(target.data("mid"), ctrl.command);
    }
  },
  render: function () {
    var client = this.props.client;
    var controls = [];
    var mid = client.mid;

    if (typeof(client.properties.ui) != "undefined") {
      controls = client.properties.ui.controls || [];
    }
    return (
      <div className="controls-block well well-sm">
      {
        controls.map(function (control) {
          if (typeof(control.group) != "undefined") { // sub-group
            return (
              <div className="well well-sm well-inner" key={control.name}>
              {control.name}<br />
              {
                control.group.map(function (ctrl) {
                  return (
                    <button key={ctrl.name}
                        className="command-btn btn btn-xs btn-warning"
                        data-mid={mid} data-ctrl={JSON.stringify(ctrl)}
                        onClick={this.onCommandClicked}>
                      {ctrl.name}
                    </button>
                  );
                }.bind(this))
              }
              </div>
            );
          }
          return (
            <div key={control.name}
                className="command-btn btn btn-xs btn-primary"
                data-mid={mid} data-ctrl={JSON.stringify(control)}
                onClick={this.onCommandClicked}>
              {control.name}
            </div>
          );
        }.bind(this))
      }
      </div>
    );
  }
});

var MainLog = React.createClass({
  appendLog: function (text) {
    var odiv = this.odiv;
    this.props.fixture.refs.lights.scanForLightMsg(text);
    var innerHTML = $(odiv).html();
    innerHTML += text.replace(/\n/g, "<br />");
    if (innerHTML.length > LOG_BUF_SIZE) {
      innerHTML = innerHTML.substr(innerHTML.length -
                                   LOG_BUF_SIZE, LOG_BUF_SIZE);
    }
    $(odiv).html(innerHTML);
    odiv.scrollTop = odiv.scrollHeight;
  },
  componentDidMount: function () {
    this.odiv = this.refs["log-" + this.props.id].getDOMNode();
  },
  render: function () {
    return (
      <div className="log log-main well well-sm" ref={"log-" + this.props.id}>
      </div>
    );
  }
});

var AuxLogs = React.createClass({
  render: function () {
    var client = this.props.client;
    var logs = [];

    if (typeof(client.properties.ui) != "undefined") {
      logs = client.properties.ui.logs || [];
    }
    return (
      <div className="log-block">
        {
          logs.map(function (filename) {
            return (
              <AuxLog mid={client.mid} filename={filename}
               fixture={this.props.fixture}/>
            )
          }.bind(this))
        }
      </div>
    );
  }
});

var AuxLog = React.createClass({
  componentDidMount: function () {
    var url = "ws" + ((window.location.protocol == "https:")? "s": "" ) +
              "://" + window.location.host + "/api/agent/shell/" +
              this.props.mid + "?command=" +
              encodeURIComponent("tail -f " + this.props.filename);
    var sock = new WebSocket(url);

    sock.onopen = function () {
      var odiv = this.refs["log-" + this.props.mid].getDOMNode();
      sock.onmessage = function (msg) {
        if (msg.data instanceof Blob) {
          ReadBlobAsText(msg.data, function (text) {
            this.props.fixture.refs.lights.scanForLightMsg(text);
            var innerHTML = $(odiv).html();
            innerHTML += text.replace(/\n/g, "<br />");
            if (innerHTML.length > LOG_BUF_SIZE) {
              innerHTML = innerHTML.substr(innerHTML.length -
                                           LOG_BUF_SIZE, LOG_BUF_SIZE);
            }
            $(odiv).html(innerHTML);
            odiv.scrollTop = odiv.scrollHeight;
          }.bind(this));
        }
      }.bind(this)
    }.bind(this)
    this.sock = sock;
  },
  componentWillUnmount: function() {
    this.sock.close();
  },
  render: function () {
    return (
      <div className="log log-aux well well-sm" ref={"log-" + this.props.mid}>
      </div>
    );
  }
});