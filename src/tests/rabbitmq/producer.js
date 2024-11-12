const amqp = require("amqplib");
const messages = "Microservice with RabbitMQ";

const producerRunner = async () => {
  try {
    const connection = await amqp.connect("amqp://guest:123@abcDE@localhost");
    if (!connection) throw new Error("Connection not established");
    const channel = await connection.createChannel();
    const queueName = "test-topic";
    await channel.assertQueue(queueName, { durable: true });
    // ? Send message to queue
    channel.sendToQueue(queueName, Buffer.from(messages));
    console.log(`Message: ${messages} sent to queue: ${queueName}`);
    setTimeout(() => {
      connection.close();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error("Error in producerRunner: ", error);
  }
};

producerRunner().catch(console.error);
