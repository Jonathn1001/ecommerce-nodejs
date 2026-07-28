const { connectToRabbitMQ, createQueue } = require("..");

const receiveMail = async () => {
  try {
    // 1. Connect to RabbitMQ
    const { channel } = await connectToRabbitMQ();
    // 2. Create topic exchange
    const exchange = "email";
    channel.assertExchange(exchange, "topic", {
      durable: false,
    });
    // 3. Create queue
    const { queue } = await createQueue(channel, "", {
      exclusive: true,
    });
    console.log(`Queue created: ${queue}`);
    const args = process.argv.slice(2);
    console.log("args: ", args);
    if (args.length === 0) {
      console.log("Usage: node receive-mail.js <message>");
      process.exit(0);
    }
    // 4. Bind queue to exchange
    args.forEach(async (topic) => {
      await channel.bindQueue(queue, exchange, topic);
    });

    // 5. Receives message to queue
    channel.consume(
      queue,
      (message) => {
        console.log(
          `Message received: ${
            message.fields.routingKey
          } - ${message.content.toString()}`
        );
      },
      {
        noAck: true,
      }
    );
  } catch (error) {
    console.error("Error in receiveMail: ", error);
  }
};

receiveMail();
