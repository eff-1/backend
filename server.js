import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import sql from "./db.js"; // ✅ PostgreSQL connection
import authRoutes from "./routes/authRoute.js"; // ✅ login/signup routes

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ CORS setup for local + Render frontend
const allowedOrigins = [
  "http://localhost:5173",
//  "https://chat-frontend-flame-six.vercel.app" // ✅ add this
  "https://frontend-hkw1bpje5-faruqs-projects-aeaad191.vercel.app"
];


app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow Postman/curl
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `CORS policy: No access from origin ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

console.log("Mounting authRoutes at /");
app.options("*", cors()); // ✅ Handle preflight

app.use(bodyParser.json());

// ✅ Health check
app.get("/health", (req, res) => {
  res.send("Backend is running 🚀");
});

// ✅ Auth routes (signup/login)
app.use("/", authRoutes);

// ✅ Get all users
app.get("/users", async (req, res) => {
  try {
    const result = await sql`SELECT id, username FROM users2`;
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ General messages
app.get("/messages/general", async (req, res) => {
  try {
    const result = await sql`
      SELECT m.*, u.username AS sender_name
      FROM messages m
      JOIN users2 u ON m.sender_id = u.id
      WHERE m.recipient_id IS NULL
      ORDER BY created_at ASC
    `;
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Private messages
app.get("/messages/private/:otherUserId", async (req, res) => {
  const { otherUserId } = req.params;
  const { currentUserId } = req.query;

  if (!currentUserId) {
    return res.status(400).json({ error: "currentUserId is required" });
  }

  try {
    const result = await sql`
      SELECT m.*, u.username AS sender_name
      FROM messages m
      JOIN users2 u ON m.sender_id = u.id
      WHERE (m.sender_id = ${currentUserId} AND m.recipient_id = ${otherUserId})
         OR (m.sender_id = ${otherUserId} AND m.recipient_id = ${currentUserId})
      ORDER BY created_at ASC
    `;
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Post general message
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

// ✅ Post private message
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

// ✅ Edit message
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

// ✅ Delete message
app.delete("/messages/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await sql`DELETE FROM messages WHERE id = ${id} RETURNING *`;
    if (result.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.json({ message: "Message deleted successfully" });
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

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port: ${PORT}`);
});