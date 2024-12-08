const { connectToRabbitMQ, createQueue } = require("..");

const receiveNotification = async () => {
  try {
    // 1. Connect to RabbitMQ
    const { channel } = await connectToRabbitMQ();
    // 2. Create fanout exchange
    const exchange = "video";
    channel.assertExchange(exchange, "fanout", {
      durable: false,
    });
    // 3. Create queue
    const { queue } = await createQueue(channel, "", {
      exclusive: true,
    });
    console.log(`Queue created: ${queue}`);
    // 4. Bind queue to exchange
    channel.bindQueue(queue, exchange, "");
    // 5. Receives message to queue
    channel.consume(
      queue,
      (message) => {
        console.log(`Message received: ${message.content.toString()}`);
      },
      {
        noAck: true,
      }
    );
  } catch (error) {
    console.error("Error in receiveNotification: ", error);
  }
};

receiveNotification();
