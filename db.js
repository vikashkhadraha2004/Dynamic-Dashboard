import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://root:root@cluster.gkjhaft.mongodb.net";

let client;

export async function getDB(dbName) {
  try {
    if (!client) {
      client = new MongoClient(MONGO_URI, {
        // Add security options
        useNewUrlParser: true,
        useUnifiedTopology: true,
        // Add timeout options
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      await client.connect();
      console.log("✅ MongoDB connected securely");
    }
    return client.db(dbName);
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    throw new Error(`Failed to connect to MongoDB: ${err.message}`);
  }
}
