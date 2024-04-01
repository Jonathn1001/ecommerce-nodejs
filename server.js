const app = require("./src/app");
const {
  app: { port },
} = require("./src/configs/config.mongodb");

const server = app.listen(process.env.PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${port}`);
});

process.on("SIGINT", () => {
  console.log("Shutting down the server");
  server.close(() => {
    process.exit(1);
  });
});
