"use strict";

const { connectToRabbitMQ } = require("..");

async function produceMessage(queueName = "ordered-queue", message) {
  const { channel } = await connectToRabbitMQ();
  await channel.assertQueue(queueName, {
    durable: true,
  });
  for (let i = 0; i < 10; i++) {
    channel.sendToQueue(queueName, Buffer.from(`${message}::${i}`), {
      persistent: true,
    });
  }

  setTimeout(() => {
    channel.close();
    process.exit(0);
  }, 500);
}

produceMessage("ordered-queue", "Ordered producer");
