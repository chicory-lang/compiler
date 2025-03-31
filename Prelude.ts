const preludeHelpers = {
    arrayIndex: `
const __chicory_array_index = (arr, index) => {
  // Basic bounds check + undefined check for safety
  const val = arr[index];
  return (index >= 0 && index < arr.length && val !== undefined) ? Some(val) : None();
};`,
    optionType: `
const Some = (value) => ({ type: "Some", value });
const None = () => ({ type: "None" });`,
    resultType: `
const Ok = (value) => ({ type: "Ok", value });
const Err = (value) => ({ type: "Err", value });`,
}

export class Prelude {
    private arrayIndex = false
    private optionType = false
    private resultType = false
    
    constructor() {}

    requireArrayIndex() {
        this.arrayIndex = true
    }
    requireOptionType() {
        this.optionType = true
    }
    requireResultType() {
        this.resultType = true
    }
    
    getPrelude() {
        let prelude = ""
        if (this.arrayIndex) {
            prelude += preludeHelpers.arrayIndex
        }
        if (this.optionType) {
            prelude += preludeHelpers.optionType
        }
        if (this.resultType) {
            prelude += preludeHelpers.resultType
        }
        return prelude.trim()
    }
}