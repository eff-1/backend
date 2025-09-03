import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
  max: 10, // Maximum number of connections
  idle_timeout: 20, // Close connections after 20s of inactivity
  connect_timeout: 10, // Connection timeout
});

// Test connection
const testConnection = async () => {
  try {
    await sql`SELECT 1`;
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
};

// Initialize database tables
const initializeTables = async () => {
  try {
    // Users table
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW()
      )
    `;

    // Messages table
    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        message_type VARCHAR(20) DEFAULT 'text',
        media_url TEXT,
        voice_duration INTEGER,
        reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        reactions JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        edited_at TIMESTAMP
      )
    `;

    // Indexes for performance
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_chat 
      ON messages(sender_id, recipient_id, created_at)
    `;
    
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_general 
      ON messages(recipient_id, created_at) 
      WHERE recipient_id IS NULL
    `;

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    throw error;
  }
};

// Run initialization
testConnection();
initializeTables();

export default sql;