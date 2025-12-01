// socket/socketHandlers.js - Enhanced with WhatsApp-like features
import sql from '../utils/database.js';
import path from 'path';
import fs from 'fs';

// Store active connections
const onlineUsers = new Map(); // userId -> socketId
const typingUsers = new Map(); // chatKey -> Set(userIds)
const userSockets = new Map(); // socketId -> userId
const userProfiles = new Map(); // userId -> {username, ...}

export const setupSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User comes online
    socket.on("user-online", async (userId) => {
      const numUserId = parseInt(userId);
      onlineUsers.set(numUserId, socket.id);
      userSockets.set(socket.id, numUserId);
      
      // Get user profile for typing indicators
      try {
        const userResult = await sql`SELECT username FROM users WHERE id = ${numUserId}`;
        if (userResult.length > 0) {
          userProfiles.set(numUserId, userResult[0]);
        }
      } catch (err) {
        console.error('Error fetching user profile:', err);
      }
      
      // Notify others user is online
      socket.broadcast.emit("user-status-change", { 
        userId: numUserId, 
        status: "online" 
      });
      
      console.log(`User ${numUserId} is now online`);
    });

    // ENHANCED: Typing indicators with actual usernames
    socket.on("typing-start", ({ userId, username, chatType, recipientId }) => {
      const numUserId = parseInt(userId);
      const chatKey = chatType === "general" 
        ? "general" 
        : `private_${Math.min(numUserId, recipientId)}_${Math.max(numUserId, recipientId)}`;
      
      if (!typingUsers.has(chatKey)) {
        typingUsers.set(chatKey, new Set());
      }
      typingUsers.get(chatKey).add(numUserId);

      // Get actual username from profile or parameter
      const actualUsername = username || userProfiles.get(numUserId)?.username || `User ${numUserId}`;

      // Emit typing to appropriate recipients with actual username
      if (chatType === "general") {
        socket.broadcast.emit("user-typing", { 
          userId: numUserId, 
          typing: true, 
          username: actualUsername,
          chatType, 
          chatId: "general" 
        });
      } else {
        const recipientSocket = onlineUsers.get(parseInt(recipientId));
        if (recipientSocket) {
          socket.to(recipientSocket).emit("user-typing", { 
            userId: numUserId, 
            typing: true, 
            username: actualUsername,
            chatType, 
            chatId: recipientId 
          });
        }
      }
    });

    socket.on("typing-stop", ({ userId, username, chatType, recipientId }) => {
      const numUserId = parseInt(userId);
      const chatKey = chatType === "general" 
        ? "general" 
        : `private_${Math.min(numUserId, recipientId)}_${Math.max(numUserId, recipientId)}`;
      
      const typingSet = typingUsers.get(chatKey);
      if (typingSet) {
        typingSet.delete(numUserId);
        if (typingSet.size === 0) {
          typingUsers.delete(chatKey);
        }
      }

      // Get actual username
      const actualUsername = username || userProfiles.get(numUserId)?.username || `User ${numUserId}`;

      // Emit stop typing
      if (chatType === "general") {
        socket.broadcast.emit("user-typing", { 
          userId: numUserId, 
          typing: false, 
          username: actualUsername,
          chatType, 
          chatId: "general" 
        });
      } else {
        const recipientSocket = onlineUsers.get(parseInt(recipientId));
        if (recipientSocket) {
          socket.to(recipientSocket).emit("user-typing", { 
            userId: numUserId, 
            typing: false, 
            username: actualUsername,
            chatType, 
            chatId: recipientId 
          });
        }
      }
    });

    // Send message with enhanced status tracking
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

        // Insert message into database with proper voice duration
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
            ${voice_duration ? parseInt(voice_duration) : null}
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

        // Confirm delivery to sender - message is SENT (single tick)
        socket.emit("message-delivered", { 
          tempId, 
          messageId: savedMessage.id, 
          status: "sent"  // Single tick - message sent to server
        });

        // Send to recipients
        if (chatType === "general") {
          socket.broadcast.emit("new-message", savedMessage);
          
          // For general chat, mark as delivered immediately (double tick)
          setTimeout(() => {
            socket.emit("message-status-updated", {
              messageId: savedMessage.id,
              status: "delivered"
            });
          }, 100);
        } else {
          const recipientSocket = onlineUsers.get(parseInt(recipient_id));
          if (recipientSocket && recipientSocket !== socket.id) {
            socket.to(recipientSocket).emit("new-message", savedMessage);
            
            // Mark as delivered when recipient receives it (double tick)
            setTimeout(() => {
              socket.emit("message-status-updated", {
                messageId: savedMessage.id,
                status: "delivered"
              });
            }, 100);
          }
        }

        console.log(`Message sent: ${message_type} message from user ${sender_id}${voice_duration ? ` (${voice_duration}s voice)` : ''}`);
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

    // ENHANCED: Delete message with proper file cleanup
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

    // FIXED: Add/Remove/Change reaction with username support
    socket.on("add-reaction", async ({ messageId, emoji, userId, username }) => {
      try {
        const numUserId = parseInt(userId);
        
        // Get message and user info
        const messageResult = await sql`
          SELECT reactions, recipient_id, sender_id FROM messages WHERE id = ${messageId}
        `;

        if (messageResult.length === 0) {
          socket.emit("message-error", { messageId, error: "Message not found" });
          return;
        }

        // Get username if not provided
        let actualUsername = username;
        if (!actualUsername) {
          const userResult = await sql`SELECT username FROM users WHERE id = ${numUserId}`;
          actualUsername = userResult[0]?.username || `User ${numUserId}`;
        }

        const message = messageResult[0];
        let reactions = Array.isArray(message.reactions) ? message.reactions : [];

        // Check if user already reacted with this EXACT emoji
        const existingReactionIndex = reactions.findIndex(
          r => r.user_id === numUserId && r.emoji === emoji
        );

        if (existingReactionIndex !== -1) {
          // TOGGLE: Remove reaction if clicking same emoji again
          reactions.splice(existingReactionIndex, 1);
          console.log(`User ${numUserId} removed reaction ${emoji} from message ${messageId}`);
        } else {
          // ADD: User can have multiple different emoji reactions
          reactions.push({ 
            user_id: numUserId, 
            emoji,
            username: actualUsername
          });
          console.log(`User ${numUserId} (${actualUsername}) added reaction ${emoji} to message ${messageId}`);
        }

        // Update database with proper JSONB handling
        const reactionsJson = JSON.stringify(reactions);
        console.log(`Updating reactions for message ${messageId}:`, reactionsJson);
        
        await sql`
          UPDATE messages 
          SET reactions = ${reactionsJson}::jsonb
          WHERE id = ${messageId}
        `;

        const reactionUpdate = { messageId: parseInt(messageId), reactions };

        // Emit to appropriate recipients - BROADCAST TO ALL INCLUDING SENDER
        if (!message.recipient_id) {
          // General chat - broadcast to EVERYONE including sender
          io.emit("reaction-added", reactionUpdate);
          console.log(`Broadcasted reaction update to general chat (${reactions.length} reactions)`);
        } else {
          // Private chat - send to BOTH users including sender
          const recipientSocket = onlineUsers.get(message.recipient_id);
          const senderSocket = onlineUsers.get(message.sender_id);
          
          if (recipientSocket) {
            io.to(recipientSocket).emit("reaction-added", reactionUpdate);
          }
          if (senderSocket) {
            io.to(senderSocket).emit("reaction-added", reactionUpdate);
          }
          console.log(`Sent reaction update to private chat users (${reactions.length} reactions)`);
        }
      } catch (error) {
        console.error('Add reaction error:', error);
        console.error('Error details:', {
          messageId,
          emoji,
          userId,
          username,
          error: error.message,
          stack: error.stack
        });
        socket.emit("message-error", { 
          messageId, 
          error: `Failed to add reaction: ${error.message}` 
        });
      }
    });

    // ENHANCED: Message status updates (seen, delivered)
    socket.on("mark-messages-seen", async ({ messageIds, chatType, chatId }) => {
      try {
        const numUserId = userSockets.get(socket.id);
        if (!numUserId) return;

        // Update message status to seen
        if (messageIds && messageIds.length > 0) {
          await sql`
            UPDATE messages 
            SET status = 'seen', seen_at = NOW()
            WHERE id = ANY(${messageIds}) 
            AND (recipient_id = ${numUserId} OR recipient_id IS NULL)
            AND sender_id != ${numUserId}
          `;

          // Notify senders that their messages were seen (blue double tick)
          const messageResults = await sql`
            SELECT DISTINCT sender_id, id FROM messages 
            WHERE id = ANY(${messageIds}) 
            AND (recipient_id = ${numUserId} OR recipient_id IS NULL)
            AND sender_id != ${numUserId}
          `;

          messageResults.forEach(({ sender_id, id }) => {
            const senderSocket = onlineUsers.get(sender_id);
            if (senderSocket) {
              socket.to(senderSocket).emit("message-seen", { 
                messageId: id,
                seenBy: numUserId,
                status: "seen"
              });
            }
          });
        }
      } catch (error) {
        console.error('Mark messages seen error:', error);
      }
    });

    // Enhanced message delivery confirmation
    socket.on("confirm-message-delivery", async ({ messageId }) => {
      try {
        await sql`
          UPDATE messages 
          SET status = 'delivered', delivered_at = NOW()
          WHERE id = ${messageId}
        `;

        // Get message sender
        const messageResult = await sql`
          SELECT sender_id FROM messages WHERE id = ${messageId}
        `;

        if (messageResult.length > 0) {
          const senderSocket = onlineUsers.get(messageResult[0].sender_id);
          if (senderSocket) {
            socket.to(senderSocket).emit("message-status-updated", {
              messageId: parseInt(messageId),
              status: "delivered"
            });
          }
        }
      } catch (error) {
        console.error('Confirm delivery error:', error);
      }
    });

    // Handle user activity for "last seen" functionality
    socket.on("user-activity", async () => {
      const userId = userSockets.get(socket.id);
      if (userId) {
        try {
          await sql`
            UPDATE users 
            SET last_seen = NOW() 
            WHERE id = ${userId}
          `;
        } catch (error) {
          console.error('Update last seen error:', error);
        }
      }
    });

    // User disconnects
    socket.on("disconnect", async () => {
      const userId = userSockets.get(socket.id);
      if (!userId) return;

      // Update last seen before disconnect
      try {
        await sql`
          UPDATE users 
          SET last_seen = NOW() 
          WHERE id = ${userId}
        `;
      } catch (error) {
        console.error('Update last seen on disconnect error:', error);
      }

      // Remove from online users
      onlineUsers.delete(userId);
      userSockets.delete(socket.id);
      userProfiles.delete(userId);

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

    // Heartbeat for connection health
    socket.on("ping", () => {
      socket.emit("pong");
    });
  });

  // Utility functions for HTTP routes
  io.getOnlineUsers = () => onlineUsers;
  io.getTypingUsers = () => typingUsers;
  io.getUserProfiles = () => userProfiles;
  
  // Periodic cleanup of stale connections
  setInterval(() => {
    console.log(`Active connections: ${io.sockets.sockets.size}`);
    console.log(`Online users: ${onlineUsers.size}`);
    console.log(`Active typing sessions: ${typingUsers.size}`);
  }, 300000); // Log every 5 minutes
};