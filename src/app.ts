import express from "express";
import deployRoutes from "./routes/deploy";
import projectRoutes from "./routes/projects";
import { GitLabDeployService } from "./services/deploy";

export function createApp(deployService : GitLabDeployService) {
  const app = express();
  const pino = require("pino-http")
  app.use(express.json());
  app.use(deployRoutes(deployService));
  app.use(projectRoutes);
  app.use((req, res, next) => {
    const start = Date.now();
    next();
  });
  return app;
}