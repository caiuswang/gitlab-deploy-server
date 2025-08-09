import express from "express";
import deployRoutes from "./routes/deploy";
import projectRoutes from "./routes/projects";
import { logger } from "./logger";

export function createApp() {
  const app = express();
  const pino = require("pino-http")
  app.use(express.json());
  app.use(deployRoutes);
  app.use(projectRoutes);
  app.use((req, res, next) => {
    const start = Date.now();
    next();
  });
  return app;
}