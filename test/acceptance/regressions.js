require('../support/test_helper');

var assert = require('../support/assert');
var _ = require('underscore');
var fs = require('fs');
var redis = require('redis');
var step = require('step');
var Windshaft = require('../../lib/windshaft');
var ServerOptions = require('../support/server_options');
var http = require('http');
var testClient = require('../support/test_client');

function rmdir_recursive_sync(dirname) {
  var files = fs.readdirSync(dirname);
  for (var i=0; i<files.length; ++i) {
    var f = dirname + "/" + files[i];
    var s = fs.lstatSync(f);
    if ( s.isFile() ) {
      fs.unlinkSync(f);
    }
    else {
        rmdir_recursive_sync(f);
    }
  }
}

suite('regressions', function() {

    var server = new Windshaft.Server(ServerOptions);
    server.setMaxListeners(0);
    var redis_client = redis.createClient(ServerOptions.redis.port);
    var res_serv; // resources server
    var res_serv_status = { numrequests:0 }; // status of resources server
    var res_serv_port = 8033; // FIXME: make configurable ?

    suiteSetup(function(done) {

      // Check that we start with an empty redis db
      redis_client.keys("*", function(err, matches) {

        if ( err ) { done(err); return; }

        assert.equal(matches.length, 0,
          "redis keys present at setup time on port " +
          ServerOptions.redis.port + ":\n" + matches.join("\n"));

        // Start a server to test external resources
        res_serv = http.createServer( function(request, response) {
            ++res_serv_status.numrequests;
            var filename = __dirname + '/../fixtures/markers' + request.url;
            fs.readFile(filename, "binary", function(err, file) {
              if ( err ) {
                response.writeHead(404, {'Content-Type': 'text/plain'});
                response.write("404 Not Found\n");
              } else {
                response.writeHead(200);
                response.write(file, "binary");
              }
              response.end();
            });
        });
        res_serv.listen(res_serv_port, done);

      });

    });

    // See https://github.com/Vizzuality/Windshaft/issues/65
    test("#65 catching non-Error exception doesn't kill the backend", function(done) {
        var mapConfig = testClient.defaultTableMapConfig('test_table');
        testClient.withLayergroup(mapConfig, function(err, requestTile, finish) {
            var options = {
                statusCode: 400,
                contentType: 'application/json; charset=utf-8'
            };
            requestTile('/0/0/0.png?testUnexpectedError=1', options, function(err, res) {
                assert.deepEqual(JSON.parse(res.body),  {"error":"test unexpected error"});
                finish(done);
            });
        });
    });

    // Test that you cannot write to the database from a tile request
    //
    // See http://github.com/CartoDB/Windshaft/issues/130
    // Needs a fix on the mapnik side:
    // https://github.com/mapnik/mapnik/pull/2143
    //
    // TODO: enable based on Mapnik version ?
    //
    test.skip("#130 database access is read-only", function(done) {

      step(
        function doGet() {
          var next = this;
          assert.response(server, {
              url: '/database/windshaft_test/table/test_table/0/0/0.png?sql=select+st_point(0,0)+as+the_geom,*+from+test_table_inserter(st_setsrid(st_point(0,0),4326),\'write\')',
              method: 'GET'
          }, {}, function(res, err) { next(err, res); });
        },
        function check(err, res) {
          if ( err ) {
              throw err;
          }
          assert.equal(res.statusCode, 400, res.statusCode + ': ' + ( res.statusCode !== 200 ? res.body : '..' ));
          var parsed = JSON.parse(res.body);
          assert.ok(parsed.error);
          var msg = parsed.error;
          assert.ok(msg.match(/read-only transaction/), msg);
          return null;
        },
        function finish(err) {
          assert.response(server, {
              url: '/database/windshaft_test/table/test_table/style',
              method: 'DELETE' },{}, function() { done(err); });
        }
      );

    });

    // See https://github.com/CartoDB/Windshaft/issues/167
    test.skip("#167 does not die on unexistent statsd host",  function(done) {
      step(
        function change_config() {
          var CustomOptions = _.clone(ServerOptions);
          CustomOptions.statsd = _.clone(CustomOptions.statsd);
          CustomOptions.statsd.host = 'whoami.vizzuality.com';
          CustomOptions.statsd.cacheDns = false;
          server = new Windshaft.Server(CustomOptions);
          server.setMaxListeners(0);
          return null;
        },
        function do_get(err) {
          if ( err ) {
              throw err;
          }
          var next = this;
          var errors = [];
          // We need multiple requests to make sure
          // statsd_client eventually tries to send
          // stats _and_ DNS lookup is given enough
          // time (an interval is used later for that)
          var numreq = 10;
          var pending = numreq;
          var completed = function(err) {
            if ( err ) {
                errors.push(err);
            }
            if ( ! --pending ) {
              setTimeout(function() {
              next(errors.length ? new Error(errors.join(',')) : null);
              }, 10);
              return;
            }
          };
          for (var i=0; i<numreq; ++i) {
            assert.response(server, {
                url: '/database/windshaft_test/table/test_table/6/31/24.png',
                method: 'GET'
            },{}, function(res, err) { completed(err); });
          }
        },
        function do_check(err) {
          if ( err ) {
              throw err;
          }
          // being alive is enough !
          return null;
        },
        function finish(err) {
          // reset server
          server = new Windshaft.Server(ServerOptions);
          done(err);
        }
      );
    });

    // See https://github.com/CartoDB/Windshaft/issues/173
    test.skip("#173 does not send db details in connection error response",  function(done) {
      var base_key = 'map_style|windshaft_test|test_table';
      step(
        function change_config() {
          var CustomOptions = _.clone(ServerOptions);
          CustomOptions.grainstore = _.clone(CustomOptions.grainstore);
          CustomOptions.grainstore.datasource = _.clone(CustomOptions.grainstore.datasource);
          CustomOptions.grainstore.datasource.port = '666';
          server = new Windshaft.Server(CustomOptions);
          server.setMaxListeners(0);
          return null;
        },
        function do_get(err) {
          if ( err ) {
              throw err;
          }
          var next = this;
          assert.response(server, {
              url: '/database/windshaft_test/table/test_table/6/31/24.png',
              method: 'GET'
          },{}, function(res, err) { next(err, res); });
        },
        function do_check(err, res) {
          if ( err ) {
              throw err;
          }
          // TODO: should be 500 !
          assert.equal(res.statusCode, 400);
          var parsed = JSON.parse(res.body);
          assert.ok(parsed.error);
          var msg = parsed.error;
          assert.ok(msg.match(/connect/), msg);
          assert.ok(!msg.match(/666/), msg);
          return null;
        },
        function finish(err) {
          // reset server
          server = new Windshaft.Server(ServerOptions);
          redis_client.del(base_key, function(e) {
            if ( e ) {
                console.error(e);
            }
            done(err);
          });
        }
      );
    });


    suiteTeardown(function(done) {

      // Close the resources server
      res_serv.close();

      var errors = [];

      // Check that we left the redis db empty
      redis_client.keys("*", function(err, matches) {
          if ( err ) {
              errors.push(err);
          }
          try {
            assert.equal(matches.length, 0, "Left over redis keys:\n" + matches.join("\n"));
          } catch (err) {
            errors.push(err);
          }

          var cachedir = global.environment.millstone.cache_basedir;
          rmdir_recursive_sync(cachedir);

          redis_client.flushall(function() {
            done(errors.length ? new Error(errors) : null);
          });
      });

    });
});
