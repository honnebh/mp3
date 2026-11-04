const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });

module.exports = mongoose.model('User', userSchema);
