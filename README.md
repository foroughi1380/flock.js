# 🚀 Flock.js: Micro-Service Leader Election for JavaScript Environments

**Flock.js** is a lightweight and robust library designed to implement the **Leader Election** algorithm in distributed JavaScript environments. It uses **BroadcastChannel** and **LocalStorage** (as a fallback) to synchronize state among browser tabs, windows, or even Web Workers.

By utilizing `Flock.js`, you ensure that at any given time, only **one "Member"** is responsible for critical tasks (such as reporting, database updates, or controlling shared resources).

-----

## Installation and Setup

### NPM / Yarn

Install the library using the Node Package Manager:

```bash
npm install flock-election
# or
yarn add flock-election
```

### Browser Usage (CDN/Module)

If you are not using a bundler (like Webpack/Rollup), you must load the files in the correct order:

```html
<script src="path/to/flockSingleton.js"></script> 
<script src="path/to/flockMember.js"></script>

<script>
    const myMember = new FlockMember({ channelName: 'my_app_flock' });
    // ...
</script>
```

-----

## Configuration and Member Creation

To create a new member of the flock, you must instantiate `FlockMember` with your desired configuration options.

### FlockMember(options)

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `channelName` | `string` | `'flock_channel_v1'` | **Most crucial** setting. The name of the channel where this flock communicates. Essential for **isolating** different flocks. |
| `heartbeatInterval` | `number` | `2000` | The time interval (in milliseconds) at which the Leader sends its **Heartbeat**. |
| `heartbeatTtl` | `number` | `5000` | The Time-To-Live (in milliseconds). If the Leader's Heartbeat is not received within this time, the Leader is presumed dead, and a new **election begins**. |
| `debug` | `boolean` | `false` | Enables internal library logging. |

### Member Creation Example

```javascript
import FlockMember from 'flock.js'; 

const myMember = new FlockMember({
    channelName: 'finance_dashboard', 
    heartbeatInterval: 1000,     // Heartbeat every 1 second
    heartbeatTtl: 4000           // Leader timeout after 4 seconds of silence
});

// This member automatically starts participating in the election upon instantiation.
```

-----

## Core Functionality and Communication with the Leader

`Flock.js` provides two main communication types: **Request/Response** and **One-way Message (Fire-and-Forget)**.

### 1\. Request and Await Response (`sendRequest`)

This method returns a `Promise` and is used for operations that require a result (e.g., fetching data, calculations). If the request times out or the Leader dies, the request is moved to the **Retry Queue**.

| Argument | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `data` | `Object` | (Required) | The payload data to be sent to the Leader. |
| `options` | `Object` | `{}` | Includes `{ timeout: number }`. Sets the maximum time to wait for a reply. Use this if your task takes longer than the default TTL. |
| `callback` | `Function` | `null` | (Optional) A traditional alternative to the Promise, with signature `(error, response) => {}`. |

```javascript
// Example using Promise and Custom Timeout
myMember.sendRequest(
    { action: 'get_heavy_data', id: 42 }, 
    { timeout: 15000 } // Waits up to 15 seconds for a response
)
.then(response => {
    console.log("Response from Leader:", response);
})
.catch(error => {
    // This error occurs only after the final TTL/Timeout has expired and all retries have failed.
    console.error("Request failed after final retries:", error.message);
});
```

### 2\. Send One-way Message (`sendMessageToLeader`)

This method is used for notifications or reporting and does not wait for a response. If the Leader does not acknowledge the message within the TTL, the message is placed in the **Retry Queue** and resent after a new Leader is elected.

```javascript
// Send a critical log or alert
myMember.sendMessageToLeader({ 
    level: 'ALERT', 
    message: 'User session expired. Force logout needed.'
});
```

-----

##  Leader Logic Implementation

The following code should only be defined once in your application, as only the actual Leader will execute the logic.

### 1\. Responding to Requests (`onRequest`)

This function accepts a callback, which in turn receives two arguments: `data` and the **`reply` function**. The Leader **must** eventually call `reply(responseData)` to send the answer back, otherwise, the Requester will timeout.

```javascript
myMember.onRequest((data, reply) => {
    console.log(`[Leader] received request:`, data);
    
    if (data.action === 'calculate') {
        // Asynchronous operations (like fetching from a database) can occur here
        fetch('/api/heavy-calc', { method: 'POST', body: JSON.stringify(data) })
            .then(res => res.json())
            .then(result => {
                // Successfully send the response back to the requester
                reply({ status: 'Completed', result: result }); 
            })
            .catch(err => {
                // Send an error response (reply must still be called)
                reply({ status: 'Error', message: err.message });
            });
    } else {
         reply({ status: 'Ignored', message: 'Action not supported' });
    }
});
```

### 2\. Reacting to Leadership Changes (`onLeadershipChange`)

This event fires whenever your membership status changes (e.g., you become the Leader, or a new Leader is found).

```javascript
myMember.onLeadershipChange((isLeader) => {
    if (isLeader) {
        console.log("🎉 I am the new Leader! Assuming critical responsibilities.");
        // Start Leader-specific timed tasks here
    } else {
        console.log("Not the Leader. Stopping all Leader duties.");
        // Clear any timed loops or resources
    }
});
```

### 3\. Listening for One-way Messages (`onMessage`)

Messages sent via `sendMessageToLeader` are received in this event.

```javascript
myMember.onMessage((message) => {
    // message includes senderId, payload, and type: 'leader-message'
    if (message.payload.level === 'ALERT') {
        console.warn(`[Leader] Urgent Alert received from Member ${message.senderId}:`, message.payload);
    }
});
```

-----

##  Utility Methods

| Method | Description |
| :--- | :--- |
| `myMember.isLeader()` | Returns whether this instance is currently the Leader (`boolean`). |
| `myMember.resign()` | Manually resigns the leadership role and triggers a new election. |
| `myMember.getMembersInfo()` | (Leader Only) Returns a list of IDs of all active members in the flock (whose status is maintained within the TTL). |
| `myMember.sendToMember(id, data)` | (Leader Only) Send a direct message to a specific member ID (no built-in retry). |
| `myMember.broadcastToMembers(data)` | (Leader Only) Broadcast a message to all members of the flock (no built-in retry). |