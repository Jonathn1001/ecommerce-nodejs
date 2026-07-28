const { kafka, Partitioners } = require("./kafka");

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

const producerRunner = async () => {
  await producer.connect();
  await producer.send({
    topic: "test-topic",
    messages: [
      { value: "Congratulation 47th President of the United States!" },
    ],
  });
  await producer.disconnect();
};

producerRunner().catch(console.error);
