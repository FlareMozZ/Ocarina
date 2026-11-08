function runQuery(query, context) {
  return Promise.resolve(query).then(
    ({ error }) => {
      if (error) console.error(`${context}:`, error.message);
    },
    (error) => console.error(`${context}:`, error.message)
  );
}

module.exports = { runQuery };
