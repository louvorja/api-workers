import { createStore } from 'vuex'

export default createStore({
  state() {
    return {
      start: false,
      loading: false,
      auth: false,
      user: {},
    }
  },
  mutations: {
    setStart(state, value) {
      state.start = value;
    },
    setLoading(state, value) {
      state.loading = value;
    },
    setAuth(state, value) {
      state.auth = value;
    },
    setUser(state, value) {
      state.user = value;
    },
  },
  getters: {
    start: (state) => state.start,
    loading: (state) => state.loading,
    auth: (state) => state.auth,
    user: (state) => state.user,
  }
})
