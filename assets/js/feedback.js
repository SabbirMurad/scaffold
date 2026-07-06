// Feedback API client — thin wrappers over the /api/v1/feedback endpoints. Shares
// the bearer-token + 401-refresh behaviour of the project client via `authed`.

import { authed } from './projects.js';

// My recent feedback plus cap state: { max_per_day, used_today, items }.
export const listFeedback = () => authed('get', { endpoint: '/v1/feedback' });

// Submit feedback. `type` is one of Bug | Idea | Question | Other.
export const sendFeedback = (type, message) =>
  authed('post', { endpoint: '/v1/feedback', body: { type, message } });
