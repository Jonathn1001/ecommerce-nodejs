const { connectToRabbitMQ, createQueue } = require("..");

const producerRunner = async ({ msg = "" }) => {
  try {
    const { connection, channel } = await connectToRabbitMQ();
    const notificationExchange = "notificationExchange";
    const notificationQueue = "notificationProcessQueue";
    const notificationExchangeDLX = "notificationExchangeDLX";
    const notificationRoutingKeyDLX = "notificationRoutingKeyDLX";
    //* 1. Create Exchange
    await channel.assertExchange(notificationExchange, "direct", {
      durable: true,
    });
    //* 2. Create DLX Queue
    const queue = await createQueue(channel, notificationQueue, {
      exclusive: false, // ? Allow multiple connections, but only one will get the message
      deadLetterExchange: notificationExchangeDLX,
      deadLetterRoutingKey: notificationRoutingKeyDLX,
    });
    //* 3. Bind DLX Queue to DLX Exchange
    await channel.bindQueue(
      queue.queue,
      notificationExchangeDLX,
      notificationRoutingKeyDLX
    );
    //* 4. Send message to queue
    channel.sendToQueue(queue.queue, Buffer.from(msg), {
      expiration: "10000", // ? Message will be deleted after 10 seconds
    });
    console.log(`Message: ${msg} sent to queue: ${queue.queue}`);
    setTimeout(() => {
      connection.close();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error("Error in producerRunner: ", error);
  }
};

producerRunner({ msg: "New Notification !!" });
