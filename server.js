const db = require("./db");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const authRoutes = require("./routes/authRoute");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

app.use(authRoutes);

app.get("/users", (req, res) => {
    const query = "SELECT id, username FROM users2";
    db.query(query, (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.status(200).json(result);
    });
});

app.get("/messages/general", (req, res) => {
    const query = `
        SELECT m.*, u.username as sender_name
        FROM messages m
        JOIN users2 u ON m.sender_id = u.id
        WHERE m.recipient_id IS NULL
        ORDER BY created_at ASC`;
    db.query(query, (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.status(200).json(result);
    })
});

app.get("/messages/private/:otherUserId", (req, res) => {
    const { otherUserId } = req.params;
    const { currentUserId } = req.query;

    if (!currentUserId) {
        return res.status(400).json({ error: 'currentUserId is required' });
    }

    const query = `
        SELECT m.*, u.username as sender_name
        FROM messages m
        JOIN users2 u ON m.sender_id = u.id
        WHERE (m.sender_id = ? AND m.recipient_id = ?)
           OR (m.sender_id = ? AND m.recipient_id = ?)
        ORDER BY created_at ASC`;

    db.query(query, [currentUserId, otherUserId, otherUserId, currentUserId], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.status(200).json(result);
    });
});

app.post("/messages/general", (req, res) => {
    const { sender_id, message, replyTo } = req.body;
    
    if (!sender_id || !message) {
        return res.status(400).json({ error: "Sender ID and message are required" });
    }
    
    const query = "INSERT INTO messages (sender_id, recipient_id, message, replyTo) VALUES (?, NULL, ?, ?)";
    db.query(query, [sender_id, message, replyTo], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.status(200).json({ id: result.insertId, sender_id, message });
    });
});

app.post("/messages/private", (req, res) => {
    const { sender_id, recipient_id, message, replyTo } = req.body;

    if (!sender_id || !recipient_id || !message) {
        return res.status(400).json({ error: "Sender ID, Recipient ID, and message are required" });
    }

    const query = "INSERT INTO messages (sender_id, recipient_id, message, replyTo) VALUES (?, ?, ?, ?)";
    db.query(query, [sender_id, recipient_id, message, replyTo], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.status(200).json({ id: result.insertId, sender_id, recipient_id, message });
    });
});

app.put("/messages/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const { message } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: "Message is required" });
    }
    
    const query = "UPDATE messages SET message = ? WHERE id = ?";
    db.query(query, [message, id], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Message not found" });
        }
        
        res.json({ id, message });
    });
});

app.delete("/messages/:id", (req, res) => {
    const id = parseInt(req.params.id);
    
    const query = "DELETE FROM messages WHERE id = ?";
    db.query(query, [id], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Message not found" });
        }
        
        res.json({ message: "Message deleted successfully" });
    });
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    console.log('Route not found:', req.method, req.path);
    res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
    console.log("Server listening on port:", PORT);
});