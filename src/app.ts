import express from 'express';
import dotenv from 'dotenv';
import { InMemoryStore } from './storage.js';
import { Controllers } from './controllers.js'

// Load environment variables
dotenv.config();

const app = express();
const store = new InMemoryStore();
const controllers = new Controllers(store)

// Middleware, needed for parsing JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.post('/events', controllers.ingestEvents);
app.put('/reference/users', controllers.updateReference);
app.get('/metrics', controllers.getMetrics);
app.get('/healthz', controllers.healthCheck);

// Start server
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('InMemoryStorage initialized');
});

export { app, store }; // Export for testing