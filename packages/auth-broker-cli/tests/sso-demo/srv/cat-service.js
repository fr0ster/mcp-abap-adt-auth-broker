module.exports = (srv) => {
  srv.on('echo', (req) => req.data.text);
};
