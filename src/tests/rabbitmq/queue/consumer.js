const { connectToRabbitMQ, createQueue } = require("..");

const consumerRunner = async (queueName = "test-topic") => {
  try {
    const { channel } = await connectToRabbitMQ();
    await createQueue(channel, queueName);
    // ? Receives message to queue
    channel.consume(
      queueName,
      (message) => {
        console.log(`Message received: ${message.content.toString()}`);
      },
      {
        noAck: true,
      }
    );
  } catch (error) {
    console.error("Error in consumerRunner: ", error);
  }
};

consumerRunner("test-topic");
