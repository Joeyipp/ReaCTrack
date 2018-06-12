const config = require('./../config/config');
var mongoose = require('mongoose');

// Configure moongoose to connect to our DB
mongoose.Promise = global.Promise;
mongoose.connect(config.MONGODB_URI);

module.exports = {mongoose};
