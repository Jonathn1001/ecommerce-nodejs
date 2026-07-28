"use strict";

const amqp = require("amqplib");

const connectToRabbitMQ = async () => {
  try {
    const connection = await amqp.connect("amqp://guest:123@abcDE@localhost");
    if (!connection) throw new Error("Error in connecting to RabbitMQ");
    const channel = await connection.createChannel();
    return { connection, channel };
  } catch (error) {
    throw new Error("error in connectToRabbitMQ: ", error);
  }
};

const createQueue = async (channel, queueName, options) => {
  try {
    return await channel.assertQueue(queueName, {
      durable: true, // ? Queue will survive server restarts
      ...options,
    });
  } catch (error) {
    throw new Error("error in createQueue: ", error);
  }
};

module.exports = {
  connectToRabbitMQ,
  createQueue,
};
