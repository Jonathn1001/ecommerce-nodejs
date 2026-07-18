"use strict";

const { connectToRabbitMQ } = require("..");

async function consumeMessage(queueName = "ordered-queue") {
  const { channel } = await connectToRabbitMQ();
  await channel.assertQueue(queueName, {
    durable: true,
  });
  // ? set prefetch to 1 to make sure only one message is consumed at a time
  channel.prefetch(1);

  //? 1. Unordered message
  channel.consume(queueName, (msg) => {
    setTimeout(() => {
      console.log(`Received message: ${msg.content.toString()}`);
      channel.ack(msg);
    }, Math.random() * 1000);
  });
  //? 2. Ordered message
  //   channel.consume(queueName, (msg) => {
  //     console.log(`Received message: ${msg.content.toString()}`);
  //     channel.ack(msg);
  //   });
}
consumeMessage("ordered-queue");
