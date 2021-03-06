let async = require('async');
//require("../utils/debug_util.js")(__filename, async);
let utils = require('../utils/utils.js');

class ContractDeployer {
  constructor(options) {
    const self = this;

    this.blockchain = options.blockchain;
    this.logger = options.logger;
    this.events = options.events;
    this.plugins = options.plugins;
    this.gasLimit = options.gasLimit;

    self.events.setCommandHandler('deploy:contract', (contract, cb) => {
      self.checkAndDeployContract(contract, null, cb);
    });
  }

  // TODO: determining the arguments could also be in a module since it's not
  // part of ta 'normal' contract deployment
  determineArguments(suppliedArgs, contract, callback) {
    const self = this;

    let args = suppliedArgs;
    if (!Array.isArray(args)) {
      args = [];
      let abi = contract.abiDefinition.find((abi) => abi.type === 'constructor');

      for (let input of abi.inputs) {
        let inputValue = suppliedArgs[input.name];
        if (!inputValue) {
          this.logger.error(__("{{inputName}} has not been defined for {{className}} constructor", {inputName: input.name, className: contract.className}));
        }
        args.push(inputValue || "");
      }
    }

    async.map(args, (arg, nextEachCb) => {
      if (arg[0] === "$") {
        let contractName = arg.substr(1);
        self.events.request('contracts:contract', contractName, (referedContract) => {
          nextEachCb(null, referedContract.deployedAddress);
        });
      } else if (Array.isArray(arg)) {
        async.map(arg, (sub_arg, nextSubEachCb) => {
          if (sub_arg[0] === "$") {
            let contractName = sub_arg.substr(1);

            self.events.request('contracts:contract', contractName, (referedContract) => {
              nextSubEachCb(null, referedContract.deployedAddress);
            });
          } else {
            nextSubEachCb(null, sub_arg);
          }
        }, (err, subRealArgs) => {
          nextEachCb(null, subRealArgs);
        });
      } else {
        nextEachCb(null, arg);
      }
    }, callback);
  }

  checkAndDeployContract(contract, params, callback) {
    let self = this;
    contract.error = false;

    if (contract.deploy === false) {
      self.events.emit("deploy:contract:undeployed", contract);
      return callback();
    }

    async.waterfall([
      function _determineArguments(next) {
        self.determineArguments(params || contract.args, contract, (err, realArgs) => {
          if (err) {
            return next(err);
          }
          contract.realArgs = realArgs;
          next();
        });
      },
      function deployIt(next) {
        if (contract.address !== undefined) {
          try {
            utils.toChecksumAddress(contract.address);
          } catch(e) {
            self.logger.error(__("error deploying %s", contract.className));
            self.logger.error(e.message);
            contract.error = e.message;
            self.events.emit("deploy:contract:error", contract);
            return next(e.message);
          }
          contract.deployedAddress = contract.address;
          self.logger.info(contract.className.bold.cyan + __(" already deployed at ").green + contract.address.bold.cyan);
          self.events.emit("deploy:contract:deployed", contract);
          return next();
        }

        // TODO find a better way to do that
        if (process.env.isTest) {
          return self.deployContract(contract, next);
        }
        // TODO: this should be a plugin API instead, if not existing, it should by default deploy the contract
        self.events.request("deploy:contract:shouldDeploy", contract, function(trackedContract) {
          if (!trackedContract) {
            return self.deployContract(contract, next);
          }

          self.blockchain.getCode(trackedContract.address, function(_getCodeErr, codeInChain) {
            if (codeInChain !== "0x") {
              self.contractAlreadyDeployed(contract, trackedContract, next);
            } else {
              self.deployContract(contract, next);
            }
          });
        });
      }
    ], callback);
  }

  contractAlreadyDeployed(contract, trackedContract, callback) {
    const self = this;
    self.logger.info(contract.className.bold.cyan + __(" already deployed at ").green + trackedContract.address.bold.cyan);
    contract.deployedAddress = trackedContract.address;
    self.events.emit("deploy:contract:deployed", contract);

    // TODO: can be moved into a afterDeploy event
    // just need to figure out the gasLimit coupling issue
    self.events.request('code-generator:contract:vanilla', contract, contract._gasLimit, (contractCode) => {
      self.events.request('runcode:eval', contractCode);
      return callback();
    });
  }

  deployContract(contract, callback) {
    let self = this;
    let accounts = [];
    let contractParams = (contract.realArgs || contract.args).slice();
    let contractCode = contract.code;
    let deploymentAccount = self.blockchain.defaultAccount();
    let deployObject;

    async.waterfall([
      // TODO: can potentially go to a beforeDeploy plugin
      function getAccounts(next) {
        self.blockchain.getAccounts(function (err, _accounts) {
          if (err) {
            return next(new Error(err));
          }
          accounts = _accounts;

          // applying deployer account configuration, if any
          if (typeof contract.fromIndex == 'number') {
            deploymentAccount = accounts[contract.fromIndex];
            if (deploymentAccount === undefined) {
              return next(__("error deploying") + " " + contract.className + ": " + __("no account found at index") + " " + contract.fromIndex + __(" check the config"));
            }
          }
          if (typeof contract.from == 'string' && typeof contract.fromIndex != 'undefined') {
            self.logger.warn(__('Both "from" and "fromIndex" are defined for contract') + ' "' + contract.className + '". ' + __('Using "from" as deployer account.'));
          }
          if (typeof contract.from == 'string') {
            deploymentAccount = contract.from;
          }

          deploymentAccount = deploymentAccount || accounts[0];
          next();
        });
      },
      function doLinking(next) {
        self.events.request('contracts:list', (_err, contracts) => {
          for (let contractObj of contracts) {
            let filename = contractObj.filename;
            let deployedAddress = contractObj.deployedAddress;
            if (deployedAddress) {
              deployedAddress = deployedAddress.substr(2);
            }
            let linkReference = '__' + filename + ":" + contractObj.className;
            if (contractCode.indexOf(linkReference) < 0) {
              continue;
            }
            if (linkReference.length > 40) {
              return next(new Error(__("{{linkReference}} is too long, try reducing the path of the contract ({{filename}}) and/or its name {{contractName}}", {linkReference: linkReference, filename: filename, contractName: contractObj.className})));
            }
            let toReplace = linkReference + "_".repeat(40 - linkReference.length);
            if (deployedAddress === undefined) {
              let libraryName = contractObj.className;
              return next(new Error(__("{{contractName}} needs {{libraryName}} but an address was not found, did you deploy it or configured an address?", {contractName: contract.className, libraryName: libraryName})));
            }
            contractCode = contractCode.replace(new RegExp(toReplace, "g"), deployedAddress);
          }
          // saving code changes back to contract object
          contract.code = contractCode;
          next();
        });
      },
      function applyBeforeDeploy(next) {
        self.plugins.emitAndRunActionsForEvent('deploy:contract:beforeDeploy', {contract: contract}, next);
      },
      function createDeployObject(next) {
        let contractObject = self.blockchain.ContractObject({abi: contract.abiDefinition});

        try {
          const dataCode = contractCode.startsWith('0x') ? contractCode : "0x" + contractCode;
          deployObject = self.blockchain.deployContractObject(contractObject, {arguments: contractParams, data: dataCode});
        } catch(e) {
          if (e.message.indexOf('Invalid number of parameters for "undefined"') >= 0) {
            return next(new Error(__("attempted to deploy %s without specifying parameters", contract.className)));
          } else {
            return next(new Error(e));
          }
        }
        next();
      },
      function estimateCorrectGas(next) {
        if (contract.gas === 'auto') {
          return deployObject.estimateGas().then((gasValue) => {
            contract.gas = gasValue;
            next();
          }).catch(next);
        }
        next();
      },
      function deployTheContract(next) {
        self.logger.info(__("deploying") + " " + contract.className.bold.cyan + " " + __("with").green + " " + contract.gas + " " + __("gas").green);

        self.blockchain.deployContractFromObject(deployObject, {
          from: deploymentAccount,
          gas: contract.gas,
          gasPrice: contract.gasPrice
        }, function(error, receipt) {
          if (error) {
            contract.error = error.message;
            self.events.emit("deploy:contract:error", contract);
            return next(new Error("error deploying =" + contract.className + "= due to error: " + error.message));
          }
          self.logger.info(contract.className.bold.cyan + " " + __("deployed at").green + " " + receipt.contractAddress.bold.cyan);
          contract.deployedAddress = receipt.contractAddress;
          contract.transactionHash = receipt.transactionHash;
          self.events.emit("deploy:contract:receipt", receipt);
          self.events.emit("deploy:contract:deployed", contract);

          // TODO: can be moved into a afterDeploy event
          // just need to figure out the gasLimit coupling issue
          self.events.request('code-generator:contract:vanilla', contract, contract._gasLimit, (contractCode) => {
            self.events.request('runcode:eval', contractCode);
            self.plugins.runActionsForEvent('deploy:contract:deployed', {contract: contract}, () => {
              return next(null, receipt);
            });
          });
        });
      }
    ], callback);
  }

}

module.exports = ContractDeployer;
