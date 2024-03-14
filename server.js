const app = require("./src/app");

const server = app.listen(process.env.PORT, () => {
  console.log(
    `Server running in ${process.env.NODE_ENV} mode on port ${process.env.PORT}`
  );
});

process.on("SIGINT", () => {
  console.log("Shutting down the server");
  server.close(() => {
    process.exit(1);
  });
});
