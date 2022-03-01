const { ArgumentParser } = require("argparse");
const prompts = require('prompts');
const IsilonClient = require('@moorewc/node-isilon');
const vsprintf = require('sprintf-js').vsprintf;
const chalk = require('chalk')

async function GetCredentials() {
    questions = [
        {
            type: 'text',
            name: 'username',
            message: 'Username:'
        },
        {
            type: 'password',
            name: 'password',
            message: 'Password:'
        }
    ]

    return await prompts(questions)
}

function GetArguments() {
    const parser = new ArgumentParser({ add_help: true });

    parser.add_argument('--hostname', { required: true, help: 'Isilon Hostname' });
    parser.add_argument('params', { nargs: '*' })
    return parser.parse_args();
}


function sizeToBytes(size) {
    const sizes = ['B', 'K', 'M', 'G', 'T']
    let bytes = parseInt(size);

    return bytes * (1024 ** sizes.indexOf(size[size.length - 1]));
}
function bytesToSize(bytes) {
    const sizes = ['B', 'K', 'M', 'G', 'T']
    if (bytes == undefined) {
        return 0.0;
    }
    if (bytes === 0) return 0.0;
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10)
    if (i === 0) return `${bytes}${sizes[i]}`
    return `${(bytes / (1024 ** i)).toFixed(1)}${sizes[i]}`
}

async function print_quotas({ quotas, filter, select = false }) {
    let i = 0;
    selections = [];

    const getQuotaSelection = async () => {
        questions = [
            {
                type: 'number',
                name: 'quota_id',
                message: 'Select Quota (CTRL-C to Exit):'
            },
        ]

        return await prompts(questions)
    }

    console.log('Num Type      Path                                                                                Hard    Soft     Adv    Used   Efficiency');
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------')
    for (quota of quotas) {
        let path = quota.path.toLowerCase();
        let type = quota.type === 'directory' ? chalk.green(quota.type) : chalk.red(quota.type);

        if (filter && path.includes(filter) || !filter) {
            i++;
            selections[i - 1] = quota
            console.log(vsprintf('%3d %-19s %-80s %7s %7s %7s %7s   %0.2f:1', [
                i,
                type,
                quota.path,
                bytesToSize(quota.thresholds.hard),
                bytesToSize(quota.thresholds.soft),
                bytesToSize(quota.thresholds.advisory),
                bytesToSize(quota.usage.logical),
                (quota.usage.logical / quota.usage.physical).toFixed(2)
            ]));
        }
    }

    if (select) {
        let { quota_id } = await getQuotaSelection()

        return selections[quota_id - 1];
    }
}

async function do_quota_search({ isilon, params }) {
    let quotas = await isilon.quotas.find({ enforced: true })

    let filter = params.shift().toLowerCase();

    print_quotas({ quotas, filter });
}

async function do_quota_resize({ isilon, params }) {
    const path = params.shift();
    const size = params.shift();
    let quota;
    let bytes = 0;

    if (!size) {
        process.exit();
    }

    do {
        console.clear();
        try {
            if (!path.startsWith('/')) {
                let quotas = await isilon.quotas.find({ enforced: true });
                quota = await print_quotas({ quotas, filter: path, select: true });
            } else {
                quota = await isilon.quotas.find({ path: path })[0];
            }

            let payload = {
                thresholds: {
                    hard: quota.thresholds.hard,
                    soft: quota.thresholds.soft,
                    advisory: quota.thresholds.advisory
                }
            }

            if (!quota) {
                process.exit();
            }

            let bytes = sizeToBytes(size);

            if (size.startsWith('+')) {
                payload.thresholds.hard += bytes;
            } else if (size.startsWith('-')) {
                payload.thresholds.hard -= bytes;
            } else {
                payload.thresholds.hard = bytes;
            }
            payload.thresholds.advisory = payload.thresholds.hard * .90;

            await isilon.quotas.update(quota.id, payload);
        } catch (error) {
            throw error;
        }
    } while (true);
}

async function do_quota_list({ isilon, params }) {
    let quotas = await isilon.quotas.find({ enforced: true })

    print_quotas({ quotas, filter: undefined });
}

async function do_quota_main({ isilon, params }) {
    cmdList = {
        'list': do_quota_list,
        'search': do_quota_search,
        'audit': do_quota_audit,
        'resize': do_quota_resize
    }

    let cmd = params.shift();
    if (!Object.keys(cmdList).includes(cmd)) {
        console.log(`isi quota ${cmd} not implemented.`)
        process.exit();
    }

    let results = cmdList[cmd]({ isilon, params });
}

async function do_volume_list({ isilon, params }) {
    let quotas;

    try {
        quotas = await isilon.quotas.find({ enforced: false })
    } catch (error) {
        throw error;
    }

    print_quotas({ quotas, filter: undefined });
}

async function do_volume_create({ isilon, params }) {
    let path = params.shift();

    try {
        let response = await isilon.quotas.create({
            path: path,
            include_snapshots: false,
            thresholds_include_overhead: false,
            type: 'directory'
        });
    } catch (error) {
        throw error;
    }
}

async function do_quota_audit({ isilon, params }) {
    let results = [];
    let path = params.shift();

    try {
        for (i of await isilon.namespace.get(path).readdir()) {

            let quotas = await isilon.quotas.find({ path: i.path });

            if (!quotas.length) {
                results.push({
                    type: 'missing',
                    path: i.path,
                    thresholds: {
                        hard: 0,
                        soft: 0,
                        advisory: 0
                    },
                    usage: {
                        logical: 1,
                        physical: 1
                    }
                })
            } else {
                results.push(quotas[0]);
            }

        }
    } catch (error) {
        throw error;
    }

    print_quotas({ quotas: results, filter: undefined })
}

async function do_volume_main({ isilon, params }) {
    cmdList = {
        'list': do_volume_list,
        'create': do_volume_create
    }

    let cmd = params.shift();
    try {
        let results = await cmdList[cmd]({ isilon, params });
    } catch (error) {
        throw error;
    }
}

(async () => {
    const options = GetArguments();
    const credentials = await GetCredentials();

    const cmdList = {
        'quota': do_quota_main,
        'volume': do_volume_main,
    }

    let cmd = options.params.shift();
    if (!Object.keys(cmdList).includes(cmd)) {
        console.log(`Command 'isi ${cmd}' not implemented.`);
        process.exit();
    }

    if (!credentials.username || !credentials.password) {
        process.exit();
    }

    const isilon = new IsilonClient({
        ssip: options.hostname,
        username: credentials.username,
        password: credentials.password
    })

    try {
        await isilon.ssip.authenticate();
    } catch (error) {
        console.log(error.response.data.message);
        process.exit();
    }

    try {
        let result = await cmdList[cmd]({ isilon: isilon, params: options.params });
    } catch (error) {
        if (error.data) {
            for (error of error.data.errors) {
                console.log(`ERROR:  ${error.message}`);
            }
        } else {
            console.trace(error);
        }
    }
})();