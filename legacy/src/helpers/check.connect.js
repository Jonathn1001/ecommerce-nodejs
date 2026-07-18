"use strict";

const mongoose = require("mongoose");
const os = require("os");

const _SECONDS = 5000;

// ? Count number of connections to the database
const connectCounter = () => {
  const numConnect = mongoose.connections.length;
  console.log(`Number of connections: ${numConnect}`);
};

// ? Check the status of the server
const overloadChecker = () => {
  setInterval(() => {
    const numConnect = mongoose.connections.length;
    const numCores = os.cpus().length;
    const memoryUsage = process.memoryUsage().rss;

    // Example maximum number of connections based on number of os cores
    const maximumConnections = numCores * 5;

    console.log(`Active connections: ${numConnect}`);
    console.log(`Memory usage: ${memoryUsage / 1024 / 1024} MB`);

    if (numConnect > maximumConnections) {
      console.log("Connection overload detected");
    }
  }, _SECONDS); // ? Monitor every 5 seconds
};

module.exports = { connectCounter, overloadChecker };
