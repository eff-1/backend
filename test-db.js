// backend/test-db.js - Test database connection
import sql from './utils/database.js';

async function testDatabase() {
  try {
    console.log('Testing database connection...');
    
    const result = await sql`SELECT NOW() as current_time`;
    console.log('✅ Database connected successfully');
    console.log('Current time:', result[0].current_time);
    
    // Test tables exist
    const tables = await sql`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('users', 'messages')
    `;
    
    console.log('Available tables:', tables.map(t => t.table_name));
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }
}

testDatabase();
