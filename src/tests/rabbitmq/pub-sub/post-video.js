const { connectToRabbitMQ } = require("..");

const postVideo = async ({ msg = "" }) => {
  try {
    // 1. Connect to RabbitMQ
    const { connection, channel } = await connectToRabbitMQ();
    // 2. Create fanout exchange
    const exchange = "video";
    channel.assertExchange(exchange, "fanout", {
      durable: false,
    });
    // 3. Send message to queue
    channel.publish(exchange, "", Buffer.from(msg));
    console.log(`Message sent: ${msg}`);
    setTimeout(() => {
      connection.close();
      process.exit(0);
    }, 500);
  } catch (error) {
    console.error("Error in postVideo: ", error);
  }
};
const msg = process.argv.slice(2).join(" ") || "MAGA";
postVideo({ msg });
