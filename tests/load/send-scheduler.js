// k6 load test (run before beta and before launch): `k6 run tests/load/send-scheduler.js`
// Targets from the build plan: API p95 < 300 ms at 200 req/s.
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    api: {
      executor: "constant-arrival-rate",
      rate: 200,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
  },
};

const API_URL = __ENV.API_URL || "http://localhost:4000";

export default function () {
  const res = http.get(`${API_URL}/health`);
  check(res, { "status is 200": (r) => r.status === 200 });
}
