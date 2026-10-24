import toast from "react-hot-toast";

/*
 * One message on screen at a time: a new error or success replaces whatever
 * was showing, and editing the field dismisses the error.
 */
const ERROR_ID = "sign-in-error";
const SUCCESS_ID = "sign-in-success";

export const showError = (message: string) => {
  toast.dismiss(SUCCESS_ID);
  return toast.error(message, { id: ERROR_ID });
};

export const showSuccess = (message: string) => {
  toast.dismiss(ERROR_ID);
  return toast.success(message, { id: SUCCESS_ID });
};

export const clearError = () => toast.dismiss(ERROR_ID);
