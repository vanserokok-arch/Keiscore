export class ExtractorRegistry {
    registry = new Map();
    register(name, extractor) {
        this.registry.set(name, extractor);
    }
    get(name) {
        return this.registry.get(name);
    }
}
//# sourceMappingURL=extractorRegistry.js.map