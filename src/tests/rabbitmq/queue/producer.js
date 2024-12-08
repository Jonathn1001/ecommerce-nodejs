const { connectToRabbitMQ, createQueue } = require("..");

const producerRunner = async ({ msg = "", queueName = "test-topic" }) => {
  try {
    const { connection, channel } = await connectToRabbitMQ();
    await createQueue(channel, queueName);
    // ? Send message to queue
    channel.sendToQueue(queueName, Buffer.from(msg), {
      expiration: "10000", // ? Message will be deleted after 10 seconds
    });
    console.log(`Message: ${msg} sent to queue: ${queueName}`);
    setTimeout(() => {
      connection.close();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error("Error in producerRunner: ", error);
  }
};

producerRunner({ msg: "The World Has Changed" });
