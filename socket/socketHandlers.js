import sql from '../utils/database.js';

// Store active connections
const onlineUsers = new Map(); // userId -> socketId
const typingUsers = new Map(); // chatKey -> Set(userIds)
const userSockets = new Map(); // socketId -> userId

export const setupSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User comes online
    socket.on("user-online", (userId) => {
      const numUserId = parseInt(userId);
      onlineUsers.set(numUserId, socket.id);
      userSockets.set(socket.id, numUserId);
      
      // Notify others user is online
      socket.broadcast.emit("user-status-change", { 
        userId: numUserId, 
        status: "online" 
      });
      
      console.log(`User ${numUserId} is now online`);
    });

    // Typing indicators
    socket.on("typing-start", ({ userId, chatType, recipientId }) => {
      const chatKey = chatType === "general" 
        ? "general" 
        : `private_${Math.min(userId, recipientId)}_${Math.max(userId, recipientId)}`;
      
      if (!typingUsers.has(chatKey)) {
        typingUsers.set(chatKey, new Set());
      }
      typingUsers.get(chatKey).add(parseInt(userId));

      // Emit typing to appropriate recipients
      if (chatType === "general") {
        socket.broadcast.emit("user-typing", { 
          userId: parseInt(userId), 
          typing: true, 
          chatType, 
          chatId: "general" 
        });
      } else {
        const recipientSocket = onlineUsers.get(parseInt(recipientId));
        if (recipientSocket) {
          socket.to(recipientSocket).emit("user-typing", { 
            userId: parseInt(userId), 
            typing: true, 
            chatType, 
            chatId: recipientId 
          });
        }
      }
    });

    socket.on("typing-stop", ({ userId, chatType, recipientId }) => {
      const chatKey = chatType === "general" 
        ? "general" 
        : `private_${Math.min(userId, recipientId)}_${Math.max(userId, recipientId)}`;
      
      const typingSet = typingUsers.get(chatKey);
      if (typingSet) {
        typingSet.delete(parseInt(userId));
        if (typingSet.size === 0) {
          typingUsers.delete(chatKey);
        }
      }

      // Emit stop typing
      if (chatType === "general") {
        socket.broadcast.emit("user-typing", { 
          userId: parseInt(userId), 
          typing: false, 
          chatType, 
          chatId: "general" 
        });
      } else {
        const recipientSocket = onlineUsers.get(parseInt(recipientId));
        if (recipientSocket) {
          socket.to(recipientSocket).emit("user-typing", { 
            userId: parseInt(userId), 
            typing: false, 
            chatType, 
            chatId: recipientId 
          });
        }
      }
    });

    // Send message
    socket.on("send-message", async (data) => {
      try {
        const { 
          tempId, 
          sender_id, 
          message, 
          chatType, 
          recipient_id, 
          replyTo, 
          message_type = 'text', 
          media_url = null, 
          voice_duration = null 
        } = data;

        // Insert message into database
        const result = await sql`
          INSERT INTO messages (
            sender_id, 
            recipient_id, 
            message, 
            reply_to, 
            message_type, 
            media_url, 
            voice_duration
          )
          VALUES (
            ${sender_id}, 
            ${chatType === "general" ? null : recipient_id}, 
            ${message}, 
            ${replyTo || null}, 
            ${message_type}, 
            ${media_url}, 
            ${voice_duration}
          )
          RETURNING *
        `;

        // Get sender info
        const senderInfo = await sql`
          SELECT username FROM users WHERE id = ${sender_id}
        `;

        const savedMessage = {
          ...result[0],
          sender_name: senderInfo[0].username,
          status: "sent"
        };

        // Confirm delivery to sender
        socket.emit("message-delivered", { 
          tempId, 
          messageId: savedMessage.id, 
          status: "delivered" 
        });

        // Send to recipients
        if (chatType === "general") {
          socket.broadcast.emit("new-message", savedMessage);
        } else {
          const recipientSocket = onlineUsers.get(parseInt(recipient_id));
          if (recipientSocket && recipientSocket !== socket.id) {
            socket.to(recipientSocket).emit("new-message", savedMessage);
          }
        }

        console.log(`Message sent: ${message_type} message from user ${sender_id}`);
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit("message-error", { 
          tempId: data.tempId, 
          error: "Failed to send message" 
        });
      }
    });

    // Edit message
    socket.on("edit-message", async ({ messageId, newMessage }) => {
      try {
        const result = await sql`
          UPDATE messages 
          SET message = ${newMessage}, edited_at = NOW() 
          WHERE id = ${messageId} 
          RETURNING *
        `;

        if (result.length === 0) {
          socket.emit("message-error", { messageId, error: "Message not found" });
          return;
        }

        const senderInfo = await sql`
          SELECT username FROM users WHERE id = ${result[0].sender_id}
        `;

        const updatedMessage = {
          ...result[0],
          sender_name: senderInfo[0].username,
          edited: true
        };

        // Send to appropriate recipients
        if (!result[0].recipient_id) {
          io.emit("message-edited", updatedMessage);
        } else {
          [result[0].sender_id, result[0].recipient_id].forEach((userId) => {
            const userSocket = onlineUsers.get(userId);
            if (userSocket) {
              socket.to(userSocket).emit("message-edited", updatedMessage);
            }
          });
          socket.emit("message-edited", updatedMessage);
        }
      } catch (error) {
        console.error('Edit message error:', error);
        socket.emit("message-error", { messageId, error: "Failed to edit message" });
      }
    });

    // Delete message
    socket.on("delete-message", async ({ messageId }) => {
      try {
        // Get message info before deletion
        const messageResult = await sql`
          SELECT * FROM messages WHERE id = ${messageId}
        `;

        if (messageResult.length === 0) {
          socket.emit("message-error", { messageId, error: "Message not found" });
          return;
        }

        const message = messageResult[0];

        // Delete associated file if exists
        if (message.media_url) {
          const filePath = path.join(process.cwd(), message.media_url);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
              console.log(`Deleted file: ${filePath}`);
            } catch (fileError) {
              console.warn('Could not delete file:', fileError.message);
            }
          }
        }

        // Delete from database
        await sql`DELETE FROM messages WHERE id = ${messageId}`;

        // Notify appropriate users
        if (!message.recipient_id) {
          io.emit("message-deleted", { messageId: parseInt(messageId) });
        } else {
          [message.sender_id, message.recipient_id].forEach((userId) => {
            const userSocket = onlineUsers.get(userId);
            if (userSocket) {
              socket.to(userSocket).emit("message-deleted", { messageId: parseInt(messageId) });
            }
          });
          socket.emit("message-deleted", { messageId: parseInt(messageId) });
        }

        console.log(`Message ${messageId} deleted successfully`);
      } catch (error) {
        console.error('Delete message error:', error);
        socket.emit("message-error", { messageId, error: "Failed to delete message" });
      }
    });

    // Add reaction
    socket.on("add-reaction", async ({ messageId, emoji, userId }) => {
      try {
        const messageResult = await sql`
          SELECT reactions, recipient_id, sender_id FROM messages WHERE id = ${messageId}
        `;

        if (messageResult.length === 0) {
          socket.emit("message-error", { messageId, error: "Message not found" });
          return;
        }

        const message = messageResult[0];
        let reactions = message.reactions || [];

        // Remove existing reaction from this user
        reactions = reactions.filter(r => r.user_id !== parseInt(userId));
        
        // Add new reaction
        reactions.push({ user_id: parseInt(userId), emoji });

        // Update database
        await sql`
          UPDATE messages 
          SET reactions = ${JSON.stringify(reactions)} 
          WHERE id = ${messageId}
        `;

        const reactionUpdate = { messageId: parseInt(messageId), reactions };

        // Emit to appropriate recipients
        if (!message.recipient_id) {
          io.emit("reaction-added", reactionUpdate);
        } else {
          [message.sender_id, message.recipient_id].forEach((uid) => {
            const userSocket = onlineUsers.get(uid);
            if (userSocket) {
              socket.to(userSocket).emit("reaction-added", reactionUpdate);
            }
          });
          socket.emit("reaction-added", reactionUpdate);
        }
      } catch (error) {
        console.error('Add reaction error:', error);
        socket.emit("message-error", { messageId, error: "Failed to add reaction" });
      }
    });

    // User disconnects
    socket.on("disconnect", () => {
      const userId = userSockets.get(socket.id);
      if (!userId) return;

      // Remove from online users
      onlineUsers.delete(userId);
      userSockets.delete(socket.id);

      // Notify others user is offline
      socket.broadcast.emit("user-status-change", { 
        userId, 
        status: "offline" 
      });

      // Clean up typing indicators
      for (const [chatKey, typingSet] of typingUsers.entries()) {
        if (typingSet.delete(userId) && typingSet.size === 0) {
          typingUsers.delete(chatKey);
        }
      }

      // Emit typing stop for this user
      socket.broadcast.emit("user-typing", { 
        userId, 
        typing: false 
      });

      console.log(`User ${userId} disconnected`);
    });

    // Handle connection errors
    socket.on("error", (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });

  // Export online users for HTTP routes
  io.getOnlineUsers = () => onlineUsers;
  io.getTypingUsers = () => typingUsers;
};