import * as path from 'path';
import * as fse from 'fs-extra';
import { isNullOrUndefined } from 'util';
import { ManifestHelper } from '..';
import { ModelDerivativeClient, IDerivativeResourceChild } from '../model-derivative';
import { parseManifest, ISvfMetadata, AssetType, ISvfManifestAsset, ISvfRoot } from './manifest';
import { IAuthOptions } from '../common';
import { IFragment, parseFragments } from './fragment';
import { IGeometryMetadata, parseGeometries } from './geometry';
import { IMesh, parseMeshes, IPoints, ILines } from './mesh';
import { IMaterial, parseMaterials } from './material';
import { PropdbReader } from './propdb-reader';

/**
 * Utility class for parsing SVF content from Model Derivative service or from local file system,
 * using the lower-level methods like {@link parseFragments} under the hood.
 * The class can only be instantiated using one of the two async static methods:
 * {@link Parser.FromFileSystem}, or {@link Parser.FromDerivativeService}.
 *
 * @example
 * const parser = await Parser.FromFileSystem('path/to/svf');
 * const fragments = await parser.listFragments();
 * console.log(fragments);
 *
 * @example
 * const auth = { client_id: 'forge client id', client_secret: 'forge client secreet' };
 * const parser = await Parser.FromDerivativeService('model urn', 'viewable guid', auth);
 * for await (const material of parser.enumerateMaterials()) {
 *   console.log(material);
 * }
 */
export class Parser {
    /**
     * Instantiates new parser for a specific SVF on local file system.
     * @async
     * @param {string} filepath Path to the *.svf file.
     * @returns {Promise<Parser>} Parser for the provided SVF.
     */
    static async FromFileSystem(filepath: string) {
        const svf = fse.readFileSync(filepath);
        const baseDir = path.dirname(filepath);
        const resolve = async (uri: string) => {
            const buffer = fse.readFileSync(path.join(baseDir, uri));
            return buffer;
        };
        return new Parser(svf, resolve);
    }

    /**
     * Instantiates new parser for a specific SVF in Forge Model Derivative service.
     * @async
     * @param {string} urn Forge model URN.
     * @param {string} guid Forge viewable GUID. The viewable(s) can be found in the manifest
     * with type: 'resource', role: 'graphics', and mime: 'application/autodesk-svf'.
     * @param {IAuthOptions} auth Credentials or access token for accessing the Model Derivative service.
     * @returns {Promise<Parser>} Parser for the provided SVF.
     */
    static async FromDerivativeService(urn: string, guid: string, auth: IAuthOptions) {
        const modelDerivativeClient = new ModelDerivativeClient(auth);
        const helper = new ManifestHelper(await modelDerivativeClient.getManifest(urn));
        const resources = helper.search({ type: 'resource', role: 'graphics', guid });
        if (resources.length === 0) {
            throw new Error(`Viewable '${guid}' not found.`);
        }
        const svfUrn = (resources[0] as IDerivativeResourceChild).urn;
        const svf = await modelDerivativeClient.getDerivative(urn, svfUrn) as Buffer;
        const baseUri = svfUrn.substr(0, svfUrn.lastIndexOf('/'));
        const resolve = async (uri: string) => {
            const buffer = await modelDerivativeClient.getDerivative(urn, baseUri + '/' + uri) as Buffer;
            return buffer;
        };
        return new Parser(svf, resolve);
    }

    protected svf: ISvfRoot;

    protected constructor(svfBuff: Buffer, protected resolve: (uri: string) => Promise<Buffer>) {
        this.svf = parseManifest(svfBuff);
    }

    protected findAsset(query: { type?: AssetType, uri?: string }): ISvfManifestAsset | undefined {
        return this.svf.manifest.assets.find(asset => {
            return (isNullOrUndefined(query.type) || asset.type === query.type)
                && (isNullOrUndefined(query.uri) || asset.URI === query.uri);
        });
    }

    /**
     * Retrieves raw binary data of a specific SVF asset.
     * @async
     * @param {string} uri Asset URI.
     * @returns {Promise<Buffer>} Asset content.
     */
    async getAsset(uri: string): Promise<Buffer> {
        return this.resolve(uri);
    }

    /**
     * Retrieves parsed SVF metadata.
     * @async
     * @returns {Promise<ISvfMetadata>} SVF metadata.
     */
    async getMetadata(): Promise<ISvfMetadata> {
        return this.svf.metadata;
    }

    /**
     * Retrieves, parses, and collects all SVF fragments.
     * @async
     * @returns {Promise<IFragment[]>} List of parsed fragments.
     */
    async listFragments(): Promise<IFragment[]> {
        const fragmentAsset = this.findAsset({ type: AssetType.FragmentList });
        if (!fragmentAsset) {
            throw new Error(`Fragment list not found.`);
        }
        const buffer = await this.getAsset(fragmentAsset.URI);
        return Array.from(parseFragments(buffer));
    }

    /**
     * Retrieves, parses, and iterates over all SVF fragments.
     * @async
     * @generator
     * @returns {AsyncIterable<IFragment>} Async iterator over parsed fragments.
     */
    async *enumerateFragments(): AsyncIterable<IFragment> {
        const fragmentAsset = this.findAsset({ type: AssetType.FragmentList });
        if (!fragmentAsset) {
            throw new Error(`Fragment list not found.`);
        }
        const buffer = await this.getAsset(fragmentAsset.URI);
        for (const fragment of parseFragments(buffer)) {
            yield fragment;
        }
    }

    /**
     * Retrieves, parses, and collects all SVF geometry metadata.
     * @async
     * @returns {Promise<IGeometryMetadata[]>} List of parsed geometry metadata.
     */
    async listGeometries(): Promise<IGeometryMetadata[]> {
        const geometryAsset = this.findAsset({ type: AssetType.GeometryMetadataList });
        if (!geometryAsset) {
            throw new Error(`Geometry metadata not found.`);
        }
        const buffer = await this.getAsset(geometryAsset.URI);
        return Array.from(parseGeometries(buffer));
    }

    /**
     * Retrieves, parses, and iterates over all SVF geometry metadata.
     * @async
     * @generator
     * @returns {AsyncIterable<IGeometryMetadata>} Async iterator over parsed geometry metadata.
     */
    async *enumerateGeometries(): AsyncIterable<IGeometryMetadata> {
        const geometryAsset = this.findAsset({ type: AssetType.GeometryMetadataList });
        if (!geometryAsset) {
            throw new Error(`Geometry metadata not found.`);
        }
        const buffer = await this.getAsset(geometryAsset.URI);
        for (const geometry of parseGeometries(buffer)) {
            yield geometry;
        }
    }

    /**
     * Gets the number of available mesh packs.
     */
    getMeshPackCount(): number {
        let count = 0;
        this.svf.manifest.assets.forEach(asset => {
            if (asset.type === AssetType.PackFile && asset.URI.match(/^\d+\.pf$/)) {
                count++;
            }
        });
        return count;
    }

    /**
     * Retrieves, parses, and collects all meshes, lines, or points in a specific SVF meshpack.
     * @async
     * @param {number} packNumber Index of mesh pack file.
     * @returns {Promise<(IMesh | ILines | IPoints | null)[]>} List of parsed meshes,
     * lines, or points (or null values for unsupported mesh types).
     */
    async listMeshPack(packNumber: number): Promise<(IMesh | ILines | IPoints | null)[]> {
        const meshPackAsset = this.findAsset({ type: AssetType.PackFile, uri: `${packNumber}.pf` });
        if (!meshPackAsset) {
            throw new Error(`Mesh packfile ${packNumber}.pf not found.`);
        }
        const buffer = await this.getAsset(meshPackAsset.URI);
        return Array.from(parseMeshes(buffer));
    }

    /**
     * Retrieves, parses, and iterates over all meshes, lines, or points in a specific SVF meshpack.
     * @async
     * @generator
     * @returns {AsyncIterable<IMesh | ILines | IPoints | null>} Async iterator over parsed meshes,
     * lines, or points (or null values for unsupported mesh types).
     */
    async *enumerateMeshPack(packNumber: number): AsyncIterable<IMesh | ILines | IPoints | null> {
        const meshPackAsset = this.findAsset({ type: AssetType.PackFile, uri: `${packNumber}.pf` });
        if (!meshPackAsset) {
            throw new Error(`Mesh packfile ${packNumber}.pf not found.`);
        }
        const buffer = await this.getAsset(meshPackAsset.URI);
        for (const mesh of parseMeshes(buffer)) {
            yield mesh;
        }
    }

    /**
     * Retrieves, parses, and collects all SVF materials.
     * @async
     * @returns {Promise<(IMaterial | null)[]>} List of parsed materials (or null values for unsupported material types).
     */
    async listMaterials(): Promise<(IMaterial | null)[]> {
        const materialsAsset = this.findAsset({ type: AssetType.ProteinMaterials, uri: `Materials.json.gz` });
        if (!materialsAsset) {
            throw new Error(`Materials not found.`);
        }
        const buffer = await this.getAsset(materialsAsset.URI);
        return Array.from(parseMaterials(buffer));
    }

    /**
     * Retrieves, parses, and iterates over all SVF materials.
     * @async
     * @generator
     * @returns {AsyncIterable<IMaterial | null>} Async iterator over parsed materials
     * (or null values for unsupported material types).
     */
    async *enumerateMaterials(): AsyncIterable<IMaterial | null> {
        const materialsAsset = this.findAsset({ type: AssetType.ProteinMaterials, uri: `Materials.json.gz` });
        if (!materialsAsset) {
            throw new Error(`Materials not found.`);
        }
        const buffer = await this.getAsset(materialsAsset.URI);
        for (const material of parseMaterials(buffer)) {
            yield material;
        }
    }

    /**
     * Finds URIs of all image assets referenced in the SVF.
     * These can then be retrieved using {@link getAsset}.
     * @returns {string[]} Image asset URIs.
     */
    listImages(): string[] {
        return this.svf.manifest.assets
            .filter(asset => asset.type === AssetType.Image)
            .map(asset => asset.URI);
    }

    /**
     * Retrieves and parses the property database.
     * @async
     * @returns {Promise<PropdbReader>} Property database reader.
     */
    async getPropertyDb(): Promise<PropdbReader> {
        const idsAsset = this.findAsset({ type: AssetType.PropertyIDs });
        const offsetsAsset = this.findAsset({ type: AssetType.PropertyOffsets });
        const avsAsset = this.findAsset({ type: AssetType.PropertyAVs });
        const attrsAsset = this.findAsset({ type: AssetType.PropertyAttributes });
        const valsAsset = this.findAsset({ type: AssetType.PropertyValues });
        if (!idsAsset || !offsetsAsset || !avsAsset || !attrsAsset || !valsAsset) {
            throw new Error('Could not parse property database. Some of the database assets are missing.');
        }
        const buffers = await Promise.all([
            this.getAsset(idsAsset.URI),
            this.getAsset(offsetsAsset.URI),
            this.getAsset(avsAsset.URI),
            this.getAsset(attrsAsset.URI),
            this.getAsset(valsAsset.URI)
        ]);
        return new PropdbReader(buffers[0], buffers[1], buffers[2], buffers[3], buffers[4]);
    }
}
