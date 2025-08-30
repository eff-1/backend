import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { createServer } from 'http';
import { Server } from 'socket.io';
import sql from "./db.js";
import authRoutes from "./routes/authRoutes.js";

dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5000;

// ✅ CORS setup for local + Render frontend
const allowedOrigins = [
  "http://localhost:5173",
  "https://frontend-xi-lilac-17.vercel.app/"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    if (
      origin.includes("localhost:5173") ||
      /\.vercel\.app$/.test(new URL(origin).hostname)
    ) {
      return callback(null, true);
    }
    
    const msg = `CORS policy: No access from origin ${origin}`;
    return callback(new Error(msg), false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// ✅ Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions
});

// ✅ Real-time tracking
const onlineUsers = new Map(); // userId -> socketId
const typingUsers = new Map(); // chatId -> Set of userIds
const userSockets = new Map(); // userId -> socketId

// ✅ WebSocket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User comes online
  socket.on('user-online', (userId) => {
    onlineUsers.set(userId, socket.id);
    userSockets.set(socket.id, userId);
    
    // Broadcast to all clients that user is online
    socket.broadcast.emit('user-status-change', { 
      userId: parseInt(userId), 
      status: 'online' 
    });
    
    console.log(`User ${userId} is now online`);
  });

  // Handle typing indicators
  socket.on('typing-start', ({ userId, chatId, chatType, recipientId }) => {
    const typingKey = chatType === 'general' ? 'general' : `private_${Math.min(userId, recipientId)}_${Math.max(userId, recipientId)}`;
    
    if (!typingUsers.has(typingKey)) {
      typingUsers.set(typingKey, new Set());
    }
    typingUsers.get(typingKey).add(parseInt(userId));
    
    // Broadcast to relevant users
    if (chatType === 'general') {
      socket.broadcast.emit('user-typing', { 
        userId: parseInt(userId), 
        typing: true, 
        chatType, 
        chatId: 'general' 
      });
    } else {
      // Send to specific recipient
      const recipientSocket = onlineUsers.get(parseInt(recipientId));
      if (recipientSocket) {
        socket.to(recipientSocket).emit('user-typing', { 
          userId: parseInt(userId), 
          typing: true, 
          chatType, 
          chatId: recipientId 
        });
      }
    }
  });

  socket.on('typing-stop', ({ userId, chatId, chatType, recipientId }) => {
    const typingKey = chatType === 'general' ? 'general' : `private_${Math.min(userId, recipientId)}_${Math.max(userId, recipientId)}`;
    
    if (typingUsers.has(typingKey)) {
      typingUsers.get(typingKey).delete(parseInt(userId));
      if (typingUsers.get(typingKey).size === 0) {
        typingUsers.delete(typingKey);
      }
    }
    
    // Broadcast to relevant users
    if (chatType === 'general') {
      socket.broadcast.emit('user-typing', { 
        userId: parseInt(userId), 
        typing: false, 
        chatType, 
        chatId: 'general' 
      });
    } else {
      const recipientSocket = onlineUsers.get(parseInt(recipientId));
      if (recipientSocket) {
        socket.to(recipientSocket).emit('user-typing', { 
          userId: parseInt(userId), 
          typing: false, 
          chatType, 
          chatId: recipientId 
        });
      }
    }
  });

  // Real-time message sending
  socket.on('send-message', async (messageData) => {
    try {
      const { tempId, sender_id, message, chatType, recipient_id, replyTo } = messageData;
      
      let result;
      if (chatType === 'general') {
        result = await sql`
          INSERT INTO messages (sender_id, recipient_id, message, replyTo, created_at)
          VALUES (${sender_id}, NULL, ${message}, ${replyTo || null}, NOW())
          RETURNING *
        `;
      } else {
        result = await sql`
          INSERT INTO messages (sender_id, recipient_id, message, replyTo, created_at)
          VALUES (${sender_id}, ${recipient_id}, ${message}, ${replyTo || null}, NOW())
          RETURNING *
        `;
      }

      // Get sender info
      const senderInfo = await sql`SELECT username FROM users2 WHERE id = ${sender_id}`;
      
      const savedMessage = {
        ...result[0],
        sender_name: senderInfo[0].username,
        status: 'sent'
      };

      // Send confirmation back to sender
      socket.emit('message-delivered', { 
        tempId, 
        messageId: savedMessage.id,
        status: 'sent'
      });

      // Broadcast to relevant users
      if (chatType === 'general') {
        // Broadcast to all connected clients for general chat
        io.emit('new-message', savedMessage);
      } else {
        // Send to both sender and recipient for private chat
        const recipientSocket = onlineUsers.get(parseInt(recipient_id));
        
        // Send to sender
        socket.emit('new-message', savedMessage);
        
        // Send to recipient if online
        if (recipientSocket) {
          socket.to(recipientSocket).emit('new-message', savedMessage);
        }
      }

      console.log('Message sent successfully:', savedMessage.id);
    } catch (err) {
      console.error('Error sending message:', err);
      socket.emit('message-error', { 
        tempId: messageData.tempId, 
        error: 'Failed to send message' 
      });
    }
  });

  // Handle message editing
  socket.on('edit-message', async ({ messageId, newMessage }) => {
    try {
      const result = await sql`
        UPDATE messages SET message = ${newMessage}
        WHERE id = ${messageId}
        RETURNING *
      `;

      if (result.length > 0) {
        const senderInfo = await sql`SELECT username FROM users2 WHERE id = ${result[0].sender_id}`;
        const updatedMessage = {
          ...result[0],
          sender_name: senderInfo[0].username,
          edited: true
        };

        // Broadcast the edit to all relevant users
        if (result[0].recipient_id === null) {
          // General chat
          io.emit('message-edited', updatedMessage);
        } else {
          // Private chat - send to both users
          const senderSocket = onlineUsers.get(result[0].sender_id);
          const recipientSocket = onlineUsers.get(result[0].recipient_id);
          
          if (senderSocket) {
            socket.to(senderSocket).emit('message-edited', updatedMessage);
          }
          if (recipientSocket) {
            socket.to(recipientSocket).emit('message-edited', updatedMessage);
          }
          socket.emit('message-edited', updatedMessage);
        }
      }
    } catch (err) {
      console.error('Error editing message:', err);
      socket.emit('message-error', { messageId, error: 'Failed to edit message' });
    }
  });

  // Handle message deletion
  socket.on('delete-message', async ({ messageId }) => {
    try {
      const messageToDelete = await sql`SELECT * FROM messages WHERE id = ${messageId}`;
      
      if (messageToDelete.length > 0) {
        await sql`DELETE FROM messages WHERE id = ${messageId}`;
        
        // Broadcast the deletion
        if (messageToDelete[0].recipient_id === null) {
          // General chat
          io.emit('message-deleted', { messageId });
        } else {
          // Private chat
          const senderSocket = onlineUsers.get(messageToDelete[0].sender_id);
          const recipientSocket = onlineUsers.get(messageToDelete[0].recipient_id);
          
          if (senderSocket) {
            socket.to(senderSocket).emit('message-deleted', { messageId });
          }
          if (recipientSocket) {
            socket.to(recipientSocket).emit('message-deleted', { messageId });
          }
          socket.emit('message-deleted', { messageId });
        }
      }
    } catch (err) {
      console.error('Error deleting message:', err);
      socket.emit('message-error', { messageId, error: 'Failed to delete message' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const userId = userSockets.get(socket.id);
    if (userId) {
      onlineUsers.delete(userId);
      userSockets.delete(socket.id);
      
      // Broadcast that user is offline
      socket.broadcast.emit('user-status-change', { 
        userId: parseInt(userId), 
        status: 'offline' 
      });
      
      // Remove from typing indicators
      for (const [chatKey, typingSet] of typingUsers.entries()) {
        if (typingSet.has(parseInt(userId))) {
          typingSet.delete(parseInt(userId));
          if (typingSet.size === 0) {
            typingUsers.delete(chatKey);
          }
          
          // Broadcast typing stop
          socket.broadcast.emit('user-typing', { 
            userId: parseInt(userId), 
            typing: false 
          });
        }
      }
      
      console.log(`User ${userId} disconnected`);
    }
  });
});

app.options("*", cors());
app.use(bodyParser.json());

// ✅ Health check
app.get("/health", (req, res) => {
  res.send("Backend is running 🚀");
});

app.get("/", (req, res) => {
  res.send("Backend is running ✅");
});

// ✅ Auth routes
app.use("/", authRoutes);

// ✅ Get all users with online status
app.get("/users", async (req, res) => {
  try {
    const result = await sql`SELECT id, username FROM users2`;
    
    // Add online status
    const usersWithStatus = result.map(user => ({
      ...user,
      isOnline: onlineUsers.has(user.id)
    }));
    
    res.status(200).json(usersWithStatus);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ General messages (keep existing for initial load)
app.get("/messages/general", async (req, res) => {
  try {
    const result = await sql`
      SELECT 
        m.*,
        u.username AS sender_name,
        parent.message AS reply_message,
        parentUser.username AS reply_sender
      FROM messages m
      JOIN users2 u ON m.sender_id = u.id
      LEFT JOIN messages parent ON m.replyTo = parent.id
      LEFT JOIN users2 parentUser ON parent.sender_id = parentUser.id
      WHERE m.recipient_id IS NULL
      ORDER BY m.created_at ASC
    `;
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Private messages (keep existing for initial load)
app.get("/messages/private/:otherUserId", async (req, res) => {
  const { otherUserId } = req.params;
  const { currentUserId } = req.query;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId is required" });
  }

  try {
    const result = await sql`
      SELECT 
        m.*,
        u.username AS sender_name,
        parent.message AS reply_message,
        parentUser.username AS reply_sender
      FROM messages m
      JOIN users2 u ON m.sender_id = u.id
      LEFT JOIN messages parent ON m.replyTo = parent.id
      LEFT JOIN users2 parentUser ON parent.sender_id = parentUser.id
      WHERE (m.sender_id = ${currentUserId} AND m.recipient_id = ${otherUserId})
         OR (m.sender_id = ${otherUserId} AND m.recipient_id = ${currentUserId})
      ORDER BY m.created_at ASC
    `;
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keep existing REST endpoints for fallback
app.post("/messages/general", async (req, res) => {
  const { sender_id, message, replyTo } = req.body;

  if (!sender_id || !message) {
    return res.status(400).json({ error: "Sender ID and message are required" });
  }

  try {
    const result = await sql`
      INSERT INTO messages (sender_id, recipient_id, message, replyTo, created_at)
      VALUES (${sender_id}, NULL, ${message}, ${replyTo || null}, NOW())
      RETURNING *
    `;
    res.status(201).json(result[0]);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/messages/private", async (req, res) => {
  const { sender_id, recipient_id, message, replyTo } = req.body;

  if (!sender_id || !recipient_id || !message) {
    return res.status(400).json({ error: "Sender ID, Recipient ID, and message are required" });
  }

  try {
    const result = await sql`
      INSERT INTO messages (sender_id, recipient_id, message, replyTo, created_at)
      VALUES (${sender_id}, ${recipient_id}, ${message}, ${replyTo || null}, NOW())
      RETURNING *
    `;
    res.status(201).json(result[0]);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put("/messages/:id", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const result = await sql`
      UPDATE messages SET message = ${message}
      WHERE id = ${id}
      RETURNING *
    `;
    if (result.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.json(result[0]); 
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/messages/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await sql`DELETE FROM messages WHERE id = ${id} RETURNING *`;
    if (result.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.json({ message: "Message deleted successfully!" });
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Catch unhandled errors
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ✅ 404 fallback
app.use((req, res) => {
  console.log("Route not found:", req.method, req.path);
  res.status(404).json({ error: "Route not found" });
});

// ✅ Start server with Socket.IO
server.listen(PORT, () => {
  // console.log(`🚀 Server with WebSocket support listening on port: ${PORT}`);
  console.log(` Server with WebSocket support listening on port: ${PORT}`)
});