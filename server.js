// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

app.use(function (req, res) {
    res.status(404).json({ message: 'Endpoint not found.', data: {} });
});

app.use(function (error, req, res, next) {
    let status = 500;
    let message = 'An unexpected server error occurred. Please try again.';
    if (error.status >= 400 && error.status < 500) {
        status = error.status;
        message = error.type === 'entity.parse.failed' ? 'The request body contains invalid JSON.' : error.message;
    } else if (error.code === 11000) {
        status = 400;
        message = 'That email is already used by another user.';
    } else if (error.name === 'ValidationError' || error.name === 'CastError') {
        status = 400;
        message = 'The request contains an invalid field value.';
    }
    res.status(status).json({ message, data: {} });
});

async function start() {
    if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env before starting the server.');
    await mongoose.connect(process.env.MONGODB_URI);
    await require('./models/user').init();
    await require('./models/task').init();
    return app.listen(port, () => console.log('Server running on port ' + port));
}

if (require.main === module) {
    start().catch(() => {
        console.error('Could not start the server. Check MONGODB_URI and your database network access.');
        process.exitCode = 1;
    });
}

module.exports = app;
