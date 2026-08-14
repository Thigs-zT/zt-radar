export const handler = async (event) => {
  console.log('Running scheduled deal scanner execution...');

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Scan completed successfully' })
  };
};