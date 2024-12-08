const { connectToRabbitMQ } = require("..");

const args = process.argv.slice(2);
console.log("args: ", args);
if (args.length === 0) {
  console.log("Usage: node send-mail.js <message>");
  process.exit(0);
}

const sendMail = async () => {
  try {
    // 1. Connect to RabbitMQ
    const { connection, channel } = await connectToRabbitMQ();
    // 2. Create topic exchange
    const exchange = "email";
    channel.assertExchange(exchange, "topic", {
      durable: false,
    });
    const topic = args[0] || "anonymous.info";
    const msg = args[1] || "Hello World!";
    console.log(`Topic: ${topic}`);
    // 3. send message to exchange
    channel.publish(exchange, topic, Buffer.from(msg));
    console.log(`Message sent: ${msg}`);
    setTimeout(() => {
      connection.close();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error("Error in sendMail: ", error);
  }
};

sendMail();
