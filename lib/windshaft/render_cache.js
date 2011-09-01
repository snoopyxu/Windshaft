var Step = require('step')
    , _ = require('underscore')
    , grainstore = require('grainstore')
    , tilelive   = require('tilelive');
require('tilelive-mapnik').registerProtocols(tilelive);


module.exports = function(){

    var mml_store  = new grainstore.MMLStore(global.environment.redis);
    var renderKey = "<%= dbname %>:<%= table %>:<%= format %>:<%= geom_type %>:<%= sql %>:<%= interactivity %>"

    var me = {
        renderers: {}
    };

    // Create a string ID from a datasource.
    me.createKey = function(params) {
        var opts =  _.clone(params); // as params is a weird arrayobj right here
        delete opts.x;
        delete opts.y;
        delete opts.z;
        delete opts.callback;
        _.defaults(opts, {dbname:'', table:'', format:'', geom_type:'', sql:'', interactivity:''});

        return _.template(renderKey, opts);
    };

    // Acquire preconfigured mapnik resource.
    // - `options` {Object} options to be passed to constructor
    // - `callback` {Function} callback to call once acquired.
    me.acquire = function(options, callback) {
        var id = this.makeId(options);
        if (!this.pools[id]) {
            this.pools[id] = this.makePool(id, options);
        }
        this.pools[id].acquire(function(err, resource) {
            callback(err, resource);
        });
    };


    // if renderer exists at key, return it, else generate a new one and save at key
    me.getRenderer = function(req, callback){
        var key = this.createKey(req.params);
        var that = this;

        if (!this.renderers[key]){
            Step(
                function(){
                    that.makeRenderer(req.params, this);
                },
                function(err, data){
                    if (err) throw err;

                    that.renderers[key] = data;
                    callback(err, data);
                }
            );
        } else {
            callback(null, this.renderers[key]);
        }
    };

    me.makeRenderer = function(params, callback){
        var that = this;

        // TODO: set default interactivity here
        // TODO: Allow mml_builder to be configured here

        var mml_builder = mml_store.mml_builder(params);

        Step(
            function generateXML(){
                mml_builder.toXML(this);
            },
            function loadMapnik(err, data){
                if (err) throw err;

                var uri = {
                    query: { base: that.createKey(params)},
                    protocol: 'mapnik:',
                    slashes: true,
                    xml: data,
                    mml: {
                        interactivity: {
                            layer: params.table,
                            fields: ['cartodb_id']
                        },
                        format: params.format
                    }
                };

                tilelive.load(uri, this);
            },
            function returnCallback(err, source){
                callback(err, source);
            }
        );
    };

    me.resetRenderer = function(regex){

    };


    me.init = function(){
        //TODO: setup timeout cache purge + set age?
    };

    me.init();


    return me;
}();