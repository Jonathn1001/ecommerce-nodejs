const amqp = require("amqplib");

const consumerRunner = async () => {
  try {
    const connection = await amqp.connect("amqp://guest:123@abcDE@localhost");
    const channel = await connection.createChannel();
    const queueName = "testQueue";
    await channel.assertQueue(queueName, { durable: true });
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

consumerRunner().catch(console.error);
