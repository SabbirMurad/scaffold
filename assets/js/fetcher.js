import { toast } from './toast.js';

class Fetcher {
    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {string|Object} options.body - The body to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async post({
        endpoint,
        headers = {},
        body,
        showError = true,
    }) {
        return await this.#commonMethods({
            endpoint: endpoint,
            method: "POST",
            headers: headers,
            body: body,
            showError: showError
        })
    }

    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {string|Object} options.body - The body to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async put({
        endpoint,
        headers = {},
        body,
        showError = true,
    }) {
        return await this.#commonMethods({
            endpoint: endpoint,
            method: "PUT",
            headers: headers,
            body: body,
            showError: showError
        })
    }

    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {string|Object} options.body - The body to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async patch({
        endpoint,
        headers = {},
        body,
        showError = true,
    }) {
        return await this.#commonMethods({
            endpoint: endpoint,
            method: "PATCH",
            headers: headers,
            body: body,
            showError: showError
        })
    }

    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {Object} options.query - The query parameters to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async delete({
        endpoint,
        headers = {},
        query = {},
        showError = true,
    }) {
        let queryStr = '';

        for (let key in query) {
            queryStr += `${key}=${query[key]}&`;

            if (Array.isArray(query[key])) {
                for (let item of query[key]) {
                    queryStr += `${key}=${item}&`;
                }
            }
            else {
                queryStr += `${key}=${query[key]}&`;
            }
        }

        queryStr = queryStr.slice(0, -1);

        return await this.#commonMethods({
            endpoint: endpoint,
            method: "DELETE",
            headers: headers,
            query: queryStr,
            showError: showError
        })
    }

    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {Object} options.query - The query parameters to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async get({
        endpoint,
        headers = {},
        query = {},
        showError = true,
    }) {
        let queryStr = '';

        for (let key in query) {
            queryStr += `${key}=${query[key]}&`;

            if (Array.isArray(query[key])) {
                for (let item of query[key]) {
                    queryStr += `${key}=${item}&`;
                }
            }
            else {
                queryStr += `${key}=${query[key]}&`;
            }
        }

        queryStr = queryStr.slice(0, -1);

        return await this.#commonMethods({
            endpoint: endpoint,
            method: "GET",
            headers: headers,
            query: queryStr,
            showError: showError
        })
    }

    /**
     * 
     * @param {string} options.endpoint - The endpoint to send the request to.
     * @param {string} options.method - The method to send the request with.
     * @param {Object} options.headers - The headers to send the request with.
     * @param {string|Object} options.body - The body to send the request with.
     * @param {Object} options.query - The query parameters to send the request with.
     * @returns {Promise<FetchResult>}
     */
    static async #commonMethods({
        endpoint,
        method,
        headers = {},
        body,
        query = '',
        showError = true
    }) {
        let _headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...headers,
        };

        let url = (window.projectDomain || '') + "/api" + endpoint;
        if (query) {
            url += "?" + query;
        }

        let reqObject = {
            method: method,
            headers: _headers,
        };

        if (body) {
            reqObject.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(url, reqObject);
        } catch (error) {
            if (showError) {
                toast.setNotification({
                    type: 'error',
                    message: error.toString(),
                })
            }

            return new FetchResult({
                ok: false,
                status: -1,
                data: null,
                error: error.toString(),
            })
        }

        if (!response.ok) {
            let error;
            try {
                const result = await response.json();
                // Backend error bodies use `message` (utils::response::Response);
                // keep `error` too for any endpoints that use that key instead.
                error = result.error || result.message || "Response Not Okay";
            } catch (e) {
                console.error(e);
                if (response.status === 400) {
                    error = "Bad request, Check the request body";
                } else if (response.status === 404) {
                    error = "Not found, Check the api route";
                } else {
                    error = "Response Not Okay";
                }
            }

            if (showError) {
                toast.setNotification({
                    type: 'error',
                    message: error,
                })
            }

            return new FetchResult({
                ok: false,
                status: response.status,
                data: null,
                error: error,
            })
        }

        let result;
        try {
            result = await response.json();
        } catch (e) {
            console.error(e);

            if (showError) {
                toast.setNotification({
                    type: 'error',
                    message: 'Error Parsing Response',
                })
            }

            return new FetchResult({
                ok: false,
                status: response.status,
                data: null,
                error: error,
            })
        }

        return new FetchResult({
            ok: true,
            status: response.status,
            data: result,
            error: null,
        })
    }
}

class FetchResult {
    constructor({
        ok,
        status,
        data,
        error
    }) {
        this.ok = ok;
        this.status = status;
        this.data = data;
        this.error = error;
    }
}

window.addEventListener("load", () => {
    window.Fetcher = Fetcher;
});

// Also expose as ES-module exports so `type="module"` scripts (e.g. auth.js)
// can import it directly without relying on the window global / load order.
export { Fetcher, FetchResult };