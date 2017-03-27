import { mapValues } from 'utils/core-utils';
import { createReducer } from 'utils/reducer-utils';

// ------------------------------
// Initial State
// ------------------------------
const initialState = {};

// ------------------------------
// Action Handlers
// ------------------------------
function onInitApplication() {
    return initialState;
}

function onInitForm(forms, { form: formName, values }) {
    const fields = mapValues(
        values,
        value => ({
            initial: value,
            value: value,
            touched: false,
            dirty: false
        })
    );

    return {
        ...forms,
        [formName]: {
            fields: fields,
            errors: {},
            warnings: {}
        }
    };
}

function onUpdateForm(forms, { form, field, value }) {
    if (!forms[form]) return forms;
    return {
        ...forms,
        [form]: updateField(forms[form], field, value)
    };
}

function onResetForm(forms, { form: formName }) {
    const form = !forms[formName];
    if (form) return forms;

    return {
        ...forms,
        [formName]: resetForm(form)
    };
}

function onDisposeForm(forms, { form }) {
    return _removeKey(forms, form);
}

// --------------------------------------------
// Exported utils for manageing the forms state
// --------------------------------------------
export function updateField(form, name, value) {
    const field = form.fields[name];
    if (!field) return form;

    const updatedField = {
        initial: field.initial,
        value: value,
        touched: true,
        dirty: value !== field.initial
    };

    return {
        ...form,
        fields: {
            ...form.fields,
            [name]: updatedField
        }
    };
}

export function resetField(form, name) {
    const field = form.fields[name];
    if (!field) return form;

    const updatedField = {
        initial: field.initial,
        value: field.initial,
        touched: false,
        dirty: false
    };

    return {
        ...form,
        fields: {
            ...form.fields,
            [name]: updatedField
        }
    };
}

export function resetForm(form) {
    const fields = mapValues(form.fields, _restFieldState);
    return { ...form, fields };
}

// --------------------------------------------
// Local util functions
// --------------------------------------------
function _restFieldState(field) {
    return {
        ...field,
        value: field.initial,
        touched: false,
        dirty: false
    };
}

function _removeKey(obj, key) {
    const { [key]: t, ...rest } = obj;
    t === t;
    return rest;
}

// ------------------------------
// Exported reducer function
// ------------------------------
export default createReducer({
    INIT_APPLICATION: onInitApplication,
    INIT_FORM: onInitForm,
    UPDATE_FORM: onUpdateForm,
    RESET_FORM: onResetForm,
    DISPOSE_FORM: onDisposeForm
});
