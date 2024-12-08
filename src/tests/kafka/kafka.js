const { Kafka, Partitioners } = require("kafkajs");

const kafka = new Kafka({
  clientId: "e-commerce",
  brokers: ["localhost:9092"],
});

module.exports = {
  kafka,
  Partitioners,
};
