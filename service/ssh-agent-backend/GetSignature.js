const AWS = require('aws-sdk');

const lib = require('./lib.js');
const ssh2 = require('./node_modules/ssh2-streams/index.js');
const crypto = require('crypto');

async function fetchPrivateKeyForParameter(keyParameter) {
    let ssm = new AWS.SSM({apiVersion: '2014-11-06'});

    let response = await ssm.getParameter({
        Name: keyParameter,
        WithDecryption: true,
    }).promise();

    return response.Parameter.Value;
}

exports.handler = async (event, context) => {
    try {
        console.log(`fn=handler event=${JSON.stringify(event)}`);

        let identity = event.requestContext.identity;
        let [caller,_] = identity.caller.split(":");
        console.log(`fn=handler caller=${caller}`);

        let { pubkey, data, flags } = JSON.parse(event.body);

        let decodedPubkey = Buffer.from(pubkey, 'base64');
        let decodedData = Buffer.from(data, 'base64');

        // Find the parameter that stores the private/public key pair for blob
        // searching the list of keys the caller has access to.
        let keyList = await lib.fetchKeyParameterListForCaller(caller);
        console.log(`fn=handler caller=${caller} keys=${keyList.join(',')}`);

        for (const keyParameter of keyList) {
            let key = await lib.fetchPublicKeyForParameter(keyParameter);
            let parsedKey = ssh2.utils.parseKey(key);

            // pubkey is base64(pubkey bits)
            // decoded_pubkey is binary key bits
            //
            // key is a string rep of the public key with comment etc
            // parsed_key is an OpenSSH key from ssh2-streams
            if (!decodedPubkey.equals(parsedKey.getPublicSSH())) {
                console.log(`fn=handler caller=${caller} key=${keyParameter} at=skip`);
                continue;
            }
            console.log(`fn=handler caller=${caller} key=${keyParameter} at=match`);

            // Depending on the parameter contents ssh2.utils.parseKey might
            // return a single key or a list of keys. We only support one.
            let privateKey = [].concat(ssh2.utils.parseKey(await fetchPrivateKeyForParameter(keyParameter)))[0];

            var signatureBlob;
            if (privateKey.type == "ssh-rsa") {
                if (flags == 2) {
                    // SSH_AGENT_RSA_SHA2_256
                    signatureBlob = Buffer.concat([Buffer.from('rsa-sha2-256'), crypto.sign('sha256', decodedData, privateKey.getPrivatePEM())]);
                } else if (flags == 4) {
                    // SSH_AGENT_RSA_SHA2_512
                    signatureBlob = Buffer.concat([Buffer.from('rsa-sha2-512'), crypto.sign('sha512', decodedData, privateKey.getPrivatePEM())]);
                } else {
                    // SSH_AGENT_RSA_SHA1
                    signatureBlob = Buffer.concat([Buffer.from('ssh-rsa'), crypto.sign('sha1', decodedData, privateKey.getPrivatePEM())]);
                }
            } else {
                signatureBlob = Buffer.concat(Buffer.from(privateKey.type), privateKey.sign(decodedData));
            }

            console.log(`fn=handler caller=${caller} key=${keyParameter} signature=${signatureBlob}`);

            return {
                'statusCode': 200,
                'body': JSON.stringify({
                    signature: signatureBlob.toString('base64'),
                }),
            }
        }
        
        return {
            'statusCode': 404,
            'body': JSON.stringify({
                message: "key blob not found in list of keys caller has access to",
            })
        }
    } catch (err) {
        console.log(err);
        return err;
    }
};
