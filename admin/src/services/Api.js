//import store from '@/store'

import Storage from "@/helpers/Storage.js";

export default {
  get(route, options = null, callback = function () {}) {
    this.call("get", route, options, null, (resp, data) => {
      callback(resp, data);
    });
  },

  post(route, body = null, callback = function () {}) {
    this.call("post", route, null, body, (resp, data) => {
      callback(resp, data);
    });
  },

  patch(route, body = null, callback = function () {}) {
    this.call("put", route, null, body, (resp, data) => {
      callback(resp, data);
    });
  },

  remove(route, callback = function () {}) {
    this.call("delete", route, null, null, (resp, data) => {
      callback(resp, data);
    });
  },

  async call(
    method,
    route,
    options = null,
    body = null,
    callback = function () {}
  ) {
    let params = "";
    if (options) {
      params = `?${this.data_to_url(options)}`;
    }

    let url = this.url(route + params);

    let headers = this.headers();

    if (body) {
      body = JSON.stringify(body || {});
    }

    let error = "";
    let response = await fetch(url, {
      method,
      headers,
      body,
    }).catch((err) => {
      error = err;
      callback(false, { error: `Erro ao conectar:  ${error}` });
      return false;
    });

    if (response.ok) {
      let data = await response.json();
      if (data.error != undefined && data.error != "") {
        callback(false, data);
        return false;
      }

      callback(true, data);
      return true;
    } else {
      if (error != "") {
        callback(false, { error: `Erro ao conectar:  ${error}` });
      } else {
        let data = await response.json();
        callback(false, data);
      }
      return false;
    }
  },
  // VITE_API_URL vence, para o build apontar a API de cada ambiente. Sem ela:
  // em localhost, o `wrangler dev` da API; fora, a API publicada.
  base_url() {
    if (import.meta.env.VITE_API_URL) {
      return import.meta.env.VITE_API_URL;
    } else if (window.location.hostname == "localhost") {
      return "http://localhost:8787";
    } else {
      return "https://api.louvorja.workers.dev";
    }
  },
  url(route) {
    let url = `${this.base_url()}/${route}`;
    return url;
  },
  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.auth_token()}`,
    };
  },
  data_to_url(data) {
    return new URLSearchParams(data).toString();
  },
  auth_token() {
    return Storage.get("token", "");
  },
  set_token(token) {
    return Storage.set("token", token);
  },
  remove_token() {
    return Storage.remove("token");
  },
};
