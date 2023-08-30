export interface Env {
    SCREEN_STATE: DurableObjectNamespace;
}

interface Session {
    webSocket: WebSocket;

    id: string;

    quit?: boolean;
}

export class ScreenState {
    store: DurableObjectStorage;

    state: DurableObjectState;

    env: Env;

    sessions: Session[];

    lastPing: number;

    pingCount: number;

    lastPong: number;

    screenSocket: WebSocket | null;

    constructor(state: DurableObjectState, env: Env) {
        this.store = state.storage;
        this.env = env;
        this.state = state;

        this.sessions = [];
        this.screenSocket = null;
        this.lastPing = 0;
        this.pingCount = 0;
        this.lastPong = 0;
    }

    async fetch(request: Request) {
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        let url = new URL(request.url);
        let path = url.pathname.slice(1).split('/');
        const isScreen = path[0] === 'ob'
        if (isScreen) {
            this.lastPing = Date.now()
            this.pingCount = 0
            this.lastPong = Date.now()
        }

        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        
        await this.handleSession(server, isScreen);

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async handleSession(webSocket: WebSocket, isScreen: boolean) {
        webSocket.accept();

        let session: Session = { webSocket, id: this.sessions.length.toString() };

        if (isScreen){
            this.screenSocket = webSocket
            this.broadcast({ screenOnline: true })
        } 
        else {
            this.sessions.push(session)
        }

        const screenOnline = this.screenSocket !== null
        if (screenOnline) session.webSocket.send(JSON.stringify({ screenOnline: true }))

        webSocket.addEventListener('message', async msg => {
            try {
                if (isScreen) {
                    this.lastPong = Date.now()
                    this.pingCount = 0
                    this.broadcast({ screenOnline: true })
                } else if(this.screenSocket !== null) {
                    if (Date.now() - this.lastPong > 10 * 1000) {
                        if (this.pingCount > 3) {
                            // this.screenSocket = null
                            // this.broadcast({ screenOnline: false })
                        }
                        if (Date.now() - this.lastPing > 1000) {
                            // if (this.screenSocket !== null) this.screenSocket.send('ping')
                            this.lastPing = Date.now()
                            this.pingCount++
                        }
                    }
                }

                if (session.quit) {
                    webSocket.close(1011, "WebSocket broken.");
                    return;
                }

                let data = JSON.parse(msg.data as string);

                if (!data.end && (data.x === undefined || data.y === undefined || data.x < 0 || data.y < 0 || data.x >= 16 || data.y >= 16)) {
                    throw Error('Invalid message');
                }

                const { x: xDat = null, y: yDat = null } = data

                if (data.end) {
                    await this.store.delete("pos" + session.id);
                } else await this.store.put("pos" + session.id, { x: xDat, y: yDat });

                const dataList = (await Promise.all(this.sessions.map(session => this.store.get("pos" + session.id)))).filter(pos => pos !== undefined)
                this.broadcast({ positions: dataList });
            } catch (err: any) {
                webSocket.send(JSON.stringify({ error: 'Something went wrong: ' + err.message }));
            }
        });

        let closeOrErrorHandler = async () => {
            session.quit = true;
            this.sessions = this.sessions.filter(member => member !== session);
        };

        webSocket.addEventListener("close", closeOrErrorHandler);
        webSocket.addEventListener("error", closeOrErrorHandler);
    }

    async broadcast(message: any) {
        if (typeof message !== "string") {
            message = JSON.stringify(message);
        }

        this.sessions = this.sessions.filter(session => {
            try {
                session.webSocket.send(message);
                return true;
            } catch (err) {
                session.quit = true;
                return false;
            }
        });

        if (this.screenSocket !== null) this.screenSocket.send(message)
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const id = env.SCREEN_STATE.idFromName('global')
        const stub = env.SCREEN_STATE.get(id);
        return await stub.fetch(request)
    }
};
