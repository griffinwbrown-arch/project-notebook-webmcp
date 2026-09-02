import handler from "vinext/server/fetch-handler";

export default {
  fetch: handler.fetch.bind(handler),
};
