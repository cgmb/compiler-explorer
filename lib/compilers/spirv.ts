// Copyright (c) 2018, 2021, Compiler Explorer Authors, Arm Ltd
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import path from 'path';

import _ from 'underscore';

import {BaseCompiler} from '../base-compiler';
import {logger} from '../logger';
import {SPIRVAsmParser} from '../parsers/asm-parser-spirv';
import * as utils from '../utils';

export class SPIRVCompiler extends BaseCompiler {
    protected translatorPath: string;
    protected disassemblerPath: string;

    static get key() {
        return 'spirv';
    }

    constructor(compilerInfo, env) {
        super(compilerInfo, env);

        this.asm = new SPIRVAsmParser();

        this.translatorPath = this.compilerProps('translatorPath');
        this.disassemblerPath = this.compilerProps('disassemblerPath');
    }

    override prepareArguments(userOptions, filters, backendOptions, inputFilename, outputFilename, libraries) {
        let options = this.optionsForFilter(filters, outputFilename);
        backendOptions = backendOptions || {};

        if (this.compiler.options) {
            const compilerOptions = _.filter(
                utils.splitArguments(this.compiler.options),
                option => option !== '-fno-crash-diagnostics',
            );

            options = options.concat(compilerOptions);
        }

        if (this.compiler.supportsOptOutput && backendOptions.produceOptInfo) {
            options = options.concat(this.compiler.optArg);
        }

        const libIncludes = this.getIncludeArguments(libraries);
        const libOptions = this.getLibraryOptions(libraries);
        let libLinks: string[] = [];
        let libPaths: string[] = [];
        let staticLibLinks: string[] = [];

        if (filters.binary) {
            libLinks = this.getSharedLibraryLinks(libraries);
            libPaths = this.getSharedLibraryPathsAsArguments(libraries);
            staticLibLinks = this.getStaticLibraryLinks(libraries);
        }

        userOptions = this.filterUserOptions(userOptions) || [];
        return options.concat(
            libIncludes,
            libOptions,
            libPaths,
            libLinks,
            userOptions,
            [this.filename(inputFilename)],
            staticLibLinks,
        );
    }

    override optionsForFilter(filters, outputFilename) {
        const sourceDir = path.dirname(outputFilename);
        const bitcodeFilename = path.join(sourceDir, this.outputFilebase + '.bc');
        return ['-cc1', '-debug-info-kind=limited', '-dwarf-version=5', '-debugger-tuning=gdb', '-o', bitcodeFilename];
    }

    getPrimaryOutputFilename(dirPath, outputFilebase) {
        return path.join(dirPath, `${outputFilebase}.bc`);
    }

    override getOutputFilename(dirPath, outputFilebase) {
        return path.join(dirPath, `${outputFilebase}.spvasm`);
    }

    override async runCompiler(compiler, options, inputFilename, execOptions) {
        const sourceDir = path.dirname(inputFilename);
        const bitcodeFilename = path.join(sourceDir, this.outputFilebase + '.bc');

        if (!execOptions) {
            execOptions = this.getDefaultExecOptions();
        }
        execOptions.customCwd = path.dirname(inputFilename);

        const newOptions = options;
        newOptions.push('-emit-llvm-bc');

        const bitcode = await this.exec(compiler, newOptions, execOptions);
        const result = this.transformToCompilationResult(bitcode, inputFilename);
        if (bitcode.code !== 0 || !(await utils.fileExists(bitcodeFilename))) {
            return result;
        }

        const spvBinFilename = path.join(sourceDir, this.outputFilebase + '.spv');
        const translatorFlags = ['-spirv-debug', bitcodeFilename, '-o', spvBinFilename];

        const spvBin = await this.exec(this.translatorPath, translatorFlags, execOptions);
        result.stdout = result.stdout.concat(utils.parseOutput(spvBin.stdout));
        result.stderr = result.stderr.concat(utils.parseOutput(spvBin.stderr));
        if (spvBin.code !== 0) {
            logger.error('LLVM to SPIR-V translation failed', spvBin);
            return result;
        }

        const spvasmFilename = path.join(sourceDir, this.outputFilebase + '.spvasm');
        const disassemblerFlags = [spvBinFilename, '-o', spvasmFilename];

        const spvasmOutput = await this.exec(this.disassemblerPath, disassemblerFlags, execOptions);
        if (spvasmOutput.code !== 0) {
            logger.error('SPIR-V binary to text failed', spvasmOutput);
        }

        result.stdout = result.stdout.concat(utils.parseOutput(spvasmOutput.stdout));
        result.stderr = result.stderr.concat(utils.parseOutput(spvasmOutput.stderr));
        return result;
    }

    async runCompilerForASTOrIR(compiler, options, inputFilename, execOptions) {
        if (!execOptions) {
            execOptions = this.getDefaultExecOptions();
        }

        execOptions.customCwd = path.dirname(inputFilename);

        const sourceDir = path.dirname(inputFilename);
        const outputFile = path.join(sourceDir, this.outputFilebase + '.bc');

        const newOptions = options;
        newOptions.concat('-S');

        const index = newOptions.indexOf(outputFile);
        if (index !== -1) {
            newOptions[index] = inputFilename.replace(path.extname(inputFilename), '.ll');
        }

        return super.runCompiler(compiler, newOptions, inputFilename, execOptions);
    }

    override async generateAST(inputFilename, options) {
        const newOptions = _.filter(options, option => option !== '-fcolor-diagnostics').concat(['-ast-dump']);

        const execOptions = this.getDefaultExecOptions();
        execOptions.maxOutput = 1024 * 1024 * 1024;

        return this.llvmAst.processAst(
            await this.runCompilerForASTOrIR(this.compiler.exe, newOptions, this.filename(inputFilename), execOptions),
        );
    }

    override async generateIR(inputFilename, options, filters) {
        const newOptions = _.filter(options, option => option !== '-fcolor-diagnostics').concat('-emit-llvm');

        const execOptions = this.getDefaultExecOptions();
        execOptions.maxOutput = 1024 * 1024 * 1024;

        const output = await this.runCompilerForASTOrIR(
            this.compiler.exe,
            newOptions,
            this.filename(inputFilename),
            execOptions,
        );
        if (output.code !== 0) {
            logger.error('Failed to run compiler to get IR code');
            return output.stderr;
        }
        const ir = await this.processIrOutput(output, filters);
        return ir.asm;
    }
}
